/**
 * 上游目录同步脚本 —— 在**能访问上游的主机**上运行。
 *
 * 存在的理由：上游对 Cloudflare Workers 的出口 IP 做了拦截（返回 456 JS 挑战页，
 * 见 docs/upstream-access.md），所以 Worker 自己拉不到数据。抓取改在这里做：
 * 本机 / 你的服务器 / cron 都能访问上游，脚本调真实公开接口拿到真实分类与商品，
 * 归一化后 POST 给 Worker 的 /api/admin/ingest 落库。
 *
 * Worker 端只做定价与存储，绝不碰上游 —— 定价规则因此仍集中在配置里一处。
 *
 * 用法：
 *   RELAYKIT_ADMIN_TOKEN=xxx \
 *   pnpm tsx scripts/sync-upstream.ts \
 *     --config relaykit.config.upstream.yaml \
 *     --site https://relaykit.mergedao.workers.dev
 *
 * 配 cron（每 15 分钟）即可让线上目录保持与上游同步。
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

import { AcgFakaPublicAdapter } from "@/supplier/acgfaka/public";
import type { SupplierCategory, SupplierProduct } from "@/supplier/types";

/**
 * 推送到站点的请求要走系统代理。
 *
 * Node 的 fetch（undici）默认**不读** HTTP(S)_PROXY 环境变量。在需要代理才能
 * 访问 Cloudflare 的环境里（例如上游可直连、但站点在墙外），直接 fetch 会超时。
 * 检测到代理才启用 —— 你自己的服务器上没有代理时，这里返回 undefined，
 * fetch 走直连，行为不变。
 */
function proxyDispatcher(): Dispatcher | undefined {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  // socks5 代理 ProxyAgent 不支持，只对 http(s) 代理生效。
  return proxy && /^https?:\/\//.test(proxy) ? new ProxyAgent(proxy) : undefined;
}

interface Args {
  config: string;
  site: string;
  token: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const config = get("config") ?? "relaykit.config.upstream.yaml";
  const token = get("token") ?? process.env.RELAYKIT_ADMIN_TOKEN ?? "";
  let site = get("site") ?? "";

  if (!token) {
    throw new Error("缺少管理令牌：设置 RELAYKIT_ADMIN_TOKEN 或传 --token");
  }

  // site 未显式给出时，从配置的 store.baseUrl 读。
  if (!site) {
    const raw = parseYaml(readFileSync(config, "utf8")) as {
      store?: { baseUrl?: string };
    };
    site = raw.store?.baseUrl ?? "";
  }
  if (!site) throw new Error("缺少站点地址：传 --site 或在配置里填 store.baseUrl");

  return { config, site: site.replace(/\/+$/, ""), token };
}

interface SupplierEntry {
  id: string;
  driver: string;
  domain?: string;
  costBasis?: "retail" | "agent";
  timeoutMs?: number;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const raw = parseYaml(readFileSync(args.config, "utf8")) as {
    suppliers?: SupplierEntry[];
  };
  const suppliers = (raw.suppliers ?? []).filter(
    (s) => s.driver === "acgfaka-public" || s.driver === "acgfaka",
  );

  if (suppliers.length === 0) {
    throw new Error(
      `${args.config} 里没有 acgfaka / acgfaka-public 上游，无需同步`,
    );
  }

  let failed = false;

  for (const supplier of suppliers) {
    if (!supplier.domain) {
      console.error(`[sync] 跳过 ${supplier.id}：缺少 domain`);
      failed = true;
      continue;
    }

    console.log(`[sync] 抓取 ${supplier.id} (${supplier.domain}) …`);

    // 读公开目录用 public 适配器即可（authenticated 驱动也走公开端点读目录）。
    // maxDetailFetches 放大：这台主机没有 Worker 的子请求配额限制。
    const adapter = new AcgFakaPublicAdapter({
      domain: supplier.domain,
      costBasis: supplier.costBasis ?? "retail",
      timeoutMs: supplier.timeoutMs ?? 30_000,
      maxDetailFetches: 500,
    });

    let categories: SupplierCategory[];
    let products: SupplierProduct[];
    try {
      // 分类与商品分别拉；商品列表内部会逐个拉详情页补齐规格与成本。
      [categories, products] = await Promise.all([
        adapter.listCategories(),
        adapter.listProducts(),
      ]);
    } catch (error) {
      console.error(
        `[sync] 抓取 ${supplier.id} 失败：`,
        error instanceof Error ? error.message : error,
      );
      failed = true;
      continue;
    }

    const withCost = products.filter(
      (p) => Object.keys(p.costByRace).length > 0,
    ).length;
    console.log(
      `[sync] ${supplier.id}: 分类 ${categories.length}，商品 ${products.length}` +
        `（含成本 ${withCost}）→ 推送到 ${args.site}`,
    );

    // 用 undici 自己的 fetch：它必须和 ProxyAgent 来自同一个 undici 实例，
    // 否则把 dispatcher 传给 Node 内置的全局 fetch 会报 UND_ERR_INVALID_ARG。
    const dispatcher = proxyDispatcher();
    const response = await undiciFetch(`${args.site}/api/admin/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({ supplierId: supplier.id, categories, products }),
      ...(dispatcher ? { dispatcher } : {}),
    });

    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      report?: { listed: number; withheld: number; delisted: number };
      error?: string;
    };

    if (!response.ok || !result.ok) {
      console.error(`[sync] ${supplier.id} 落库失败：`, result.error ?? response.status);
      failed = true;
      continue;
    }

    const r = result.report;
    console.log(
      `[sync] ${supplier.id} 完成：上架 ${r?.listed} 下架 ${r?.withheld} ` +
        `移除 ${r?.delisted}`,
    );
  }

  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("[sync] 未捕获错误：", error);
  process.exit(1);
});
