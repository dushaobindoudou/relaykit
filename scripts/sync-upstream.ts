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
// FormData 必须从这里 import：undici 的 fetch 只认**同一个 undici 实例**
// 产出的 FormData（realm 不匹配时不会设置 multipart 头，服务端直接 400）。
// Blob 没有这个问题（鸭子类型检测），用全局的即可。
import {
  fetch as undiciFetch,
  FormData,
  ProxyAgent,
  type Dispatcher,
} from "undici";
import sharp from "sharp";

import { AcgFakaPublicAdapter } from "@/supplier/acgfaka/public";
import type { SupplierCategory, SupplierProduct } from "@/supplier/types";
import {
  applyImageRewrites,
  planCatalogImages,
  normalizeRemoteImage,
  type MediaRewritable,
} from "@/media/keys";

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
  /** --no-images：跳过图片本地化，封面/描述图保持上游地址直接入库。 */
  noImages: boolean;
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
  const noImages = argv.includes("--no-images");

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

  return { config, site: site.replace(/\/+$/, ""), token, noImages };
}

interface SupplierEntry {
  id: string;
  driver: string;
  domain?: string;
  costBasis?: "retail" | "agent";
  timeoutMs?: number;
}

/** 单张图最大 8MiB。上游有 800KB+ 的原图，留足余量；再大的按失败处理。 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 下载一张图并压缩成 webp。
 *
 * 封面统一压到 800px 内（店面最大显示位是商品卡 1:1 方块，800 足够 retina），
 * 质量 82 —— 上游 824KB 的 PNG 通常压到 60-120KB，肉眼无差。
 * 任何一步失败都返回 null，让调用方保留上游 URL，绝不让配图失败拖垮目录。
 */
async function fetchAndCompress(
  url: string,
  referer: string,
  dispatcher: Dispatcher | undefined,
  size: "cover" | "icon",
): Promise<{ key: string; webp: Buffer } | null> {
  try {
    const response = await undiciFetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        referer,
      },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.byteLength === 0 || raw.byteLength > IMAGE_MAX_BYTES) return null;

    const edge = size === "icon" ? 256 : 800;
    const webp = await sharp(raw)
      .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    if (webp.byteLength === 0) return null;
    return { key: url, webp };
  } catch {
    return null;
  }
}

/**
 * 把目录里的上游图片本地化：下载 → 压缩 → multipart 推给 /api/admin/media，
 * 再把成功条目的 URL 改写成站点相对路径。失败逐张跳过，不影响目录本身。
 */
async function localizeImages(options: {
  site: string;
  token: string;
  supplierDomain: string;
  products: MediaRewritable[];
  categories: SupplierCategory[];
  dispatcher: Dispatcher | undefined;
}): Promise<void> {
  const { site, token, supplierDomain, products, categories, dispatcher } = options;
  const { plan } = planCatalogImages(products, categories);
  if (plan.size === 0) {
    console.log(`[media] 没有需要本地化的图片`);
    return;
  }
  // /media/路径 → 原始 URL。上传结果里只有键名，靠它反查登记改写。
  const originalByPath = new Map([...plan].map(([original, path]) => [path, original]));

  // R2 的键（covers/xxx.webp）→ 压缩产物。逐张下载，成功的进键值对。
  const entries: { key: string; webp: Buffer }[] = [];
  let done = 0;
  for (const [url, path] of plan) {
    const size = path.includes("/categories/") ? "icon" : "cover";
    const result = await fetchAndCompress(url, supplierDomain, dispatcher, size);
    done += 1;
    if (result) {
      // path 形如 /media/covers/x.webp —— 去掉 /media/ 前缀就是 R2 键。
      entries.push({ key: path.replace(/^\/media\//, ""), webp: result.webp });
    }
    if (done % 20 === 0) console.log(`[media] 已处理 ${done}/${plan.size}`);
  }

  if (entries.length === 0) {
    console.error("[media] 全部图片处理失败，目录保持上游 URL");
    return;
  }

  // 分批上传：60 个一批是服务端上限，留出网络重试的粒度。
  const urlMap = new Map<string, string>();
  for (let start = 0; start < entries.length; start += 60) {
    const batch = entries.slice(start, start + 60);
    const form = new FormData();
    for (const entry of batch) {
      form.append("file", new Blob([new Uint8Array(entry.webp)], { type: "image/webp" }), entry.key);
    }

    const response = await undiciFetch(`${site}/api/admin/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      ...(dispatcher ? { dispatcher } : {}),
    });
    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      uploaded?: { key: string; path: string }[];
      error?: string;
    };
    if (!response.ok || !result.ok) {
      console.error(`[media] 批次上传失败：`, result.error ?? response.status);
      continue;
    }
    for (const item of result.uploaded ?? []) {
      const mediaPath = `/media/${item.key}`;
      const original = originalByPath.get(mediaPath);
      if (original) urlMap.set(original, mediaPath);
    }
  }

  applyImageRewrites(products, categories, urlMap);
  console.log(
    `[media] 本地化成功 ${urlMap.size}/${plan.size}` +
      `（失败的图保留上游地址）`,
  );
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

    // 图片本地化在落库**之前**：改写后的 /media/* URL 随目录一起进 DB，
    // 店面从头到尾不见上游图床的地址。--no-images 可整体跳过。
    const dispatcher = proxyDispatcher();
    if (!args.noImages) {
      try {
        await localizeImages({
          site: args.site,
          token: args.token,
          supplierDomain: supplier.domain,
          products,
          categories,
          dispatcher,
        });
      } catch (error) {
        // 图片失败绝不阻断目录同步 —— 最坏情况就是这轮继续用上游地址。
        console.error(
          `[media] ${supplier.id} 图片本地化失败（目录继续用上游 URL）：`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // 用 undici 自己的 fetch：它必须和 ProxyAgent 来自同一个 undici 实例，
    // 否则把 dispatcher 传给 Node 内置的全局 fetch 会报 UND_ERR_INVALID_ARG。
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
