/**
 * 诊断端点。
 *
 * 自托管项目里这是最重要的一个页面：配置错了、上游连不上、余额见底、
 * 汇率过期 —— 这些都必须能在一个 URL 里看清楚，而不是让人去翻 Workers 日志。
 *
 * 刻意不鉴权但**刻意不泄露任何密钥**：只回答"通没通"，不回显 appKey、
 * 收款地址等敏感值。有意让它可以直接贴给别人求助。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq, sql } from "drizzle-orm";

import { buildContext, type Bindings } from "@/runtime/context";
import { fxFromConfig } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { products } from "@/db/schema";

export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);

  if (!result.ok || !result.context) {
    // 配置本身就没过，后面的检查无从谈起。整个响应就是这条错误。
    return Response.json(
      {
        ok: false,
        checks: [{ name: "config", ok: false, detail: result.error ?? "未知错误" }],
      },
      { status: 503 },
    );
  }

  const context = result.context;
  const checks: Check[] = [
    {
      name: "config",
      ok: true,
      detail:
        `店铺「${context.config.store.name}」· 结算币 ${context.config.store.currency} · ` +
        `${context.config.suppliers.length} 个上游 · 履约模式 ${context.config.fulfillment.mode}`,
    },
  ];

  // —— 数据库 ——
  try {
    await context.db.run(sql`select 1`);
    checks.push({ name: "database", ok: true, detail: "D1 可读写" });
  } catch (error) {
    checks.push({
      name: "database",
      ok: false,
      detail:
        `D1 查询失败：${error instanceof Error ? error.message : String(error)}。` +
        `多半是迁移没跑：wrangler d1 migrations apply relaykit --remote`,
    });
  }

  // —— 汇率新鲜度 ——
  const fx = fxFromConfig(context);
  const ageHours = (Date.now() - fx.fetchedAt.getTime()) / 3_600_000;
  const maxAge = context.config.pricing.maxStalenessHours;
  const fxOk = maxAge === 0 || ageHours <= maxAge;
  checks.push({
    name: "fx",
    ok: fxOk,
    detail: fxOk
      ? `汇率 ${ageHours.toFixed(1)} 小时前采集，在 ${maxAge} 小时窗口内`
      : `汇率已 ${ageHours.toFixed(1)} 小时未更新，超过 ${maxAge} 小时上限。` +
        `商品会全部停止上架。更新 pricing.fx.updatedAt 与汇率值后重新部署。`,
  });

  // —— 收款地址 ——
  // 放在上游检查之前：地址没配好的话，上游通不通都无关紧要 —— 钱根本收不进来。
  for (const chain of context.config.payments.chains) {
    if (!chain.enabled) continue;
    const placeholder = isPlaceholderAddress(chain.address);
    checks.push({
      name: `payments:${chain.id}`,
      ok: !placeholder,
      detail: placeholder
        ? `收款地址仍是占位值，该链无法收款，下单接口会拒绝建单。` +
          `请执行 wrangler secret put ${chain.id.toUpperCase()}_ADDRESS 后重新部署。`
        : // 只回显首尾各 6 位：既能让人核对是不是自己那个地址，又不至于
          // 把完整地址放进一个可以随便贴给别人的诊断响应里。
          `收款地址 ${chain.address.slice(0, 6)}…${chain.address.slice(-6)}，` +
          `需 ${chain.confirmations} 个确认`,
    });
  }

  // —— 逐个上游 ——
  // 串行，避免对小站造成并发压力。
  for (const supplierConfig of context.config.suppliers) {
    const adapter = context.suppliers.get(supplierConfig.id);
    if (!adapter) continue;

    // 注入式上游（acgfaka-public）：Worker 本就连不上上游（数据由同步脚本
    // 推入），所以直连必然失败。它的健康应当看**目录新鲜度**：多久没被同步过。
    if (supplierConfig.driver === "acgfaka-public") {
      const rows = await context.db
        .select({
          sellable: sql<number>`sum(case when ${products.sellable} then 1 else 0 end)`,
          latest: sql<string>`max(${products.syncedAt})`,
        })
        .from(products)
        .where(eq(products.supplierId, supplierConfig.id));

      const sellable = Number(rows[0]?.sellable ?? 0);
      const latest = rows[0]?.latest ?? null;
      // 超过 1 小时没同步就告警：说明外部同步脚本可能挂了（cron 停了、
      // 那台主机也访问不了上游了）。
      const ageMinutes = latest
        ? (Date.now() - new Date(latest).getTime()) / 60_000
        : Infinity;
      const stale = ageMinutes > 60;

      checks.push({
        name: `supplier:${supplierConfig.id}`,
        ok: sellable > 0 && !stale,
        detail:
          sellable === 0
            ? `目录为空。由 scripts/sync-upstream.ts 从可访问上游的主机推入数据，` +
              `请确认该同步脚本已运行（见 docs/upstream-access.md）。`
            : stale
              ? `目录已 ${ageMinutes === Infinity ? "从未" : Math.round(ageMinutes) + " 分钟未"}` +
                `同步（在架 ${sellable} 项）。同步脚本可能已停止运行。`
              : `注入式上游，在架 ${sellable} 项，${Math.round(ageMinutes)} 分钟前同步`,
      });
      continue;
    }

    try {
      const { shopName, balance } = await adapter.connect();
      const threshold = Number(context.config.fulfillment.balanceAlertThreshold);
      const low = Number(balance) < threshold;

      checks.push({
        name: `supplier:${supplierConfig.id}`,
        ok: !low,
        detail: low
          ? `已连通「${shopName}」，但余额 ${balance} 低于告警阈值 ${threshold}。` +
            `余额耗尽会导致客户付款后无法发货${
              context.config.fulfillment.haltSalesOnLowBalance
                ? "（已开启自动停售保护）"
                : "（**未**开启自动停售保护，风险更高）"
            }。`
          : `已连通「${shopName}」，余额 ${balance}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name: `supplier:${supplierConfig.id}`,
        ok: false,
        detail:
          `连接失败：${message}` +
          (/商户ID不存在/.test(message)
            ? " → app_id 填错了（签名尚未被校验到）"
            : /密钥错误/.test(message)
              ? " → app_id 正确但签名不匹配，请核对 app_key"
              : ""),
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
