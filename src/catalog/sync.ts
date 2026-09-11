/**
 * 商品目录同步：拉上游商品 → 逐规格定价 → 写入本地快照。
 *
 * 为什么要落快照而不是每次现拉：上游的 items 接口按其源码注释返回的是
 * "尽力而为"的缓存读数，且每次调用都是一次跨站 HTTP。店面列表页要能在
 * 几十毫秒内渲染，不能挂在别人的响应时间上。
 *
 * 但快照只用于**展示**。下单前的库存与价格必须现拉 —— 见 orders/service。
 */

import { and, eq } from "drizzle-orm";

import type { RelayKitContext } from "@/runtime/context";
import { products } from "@/db/schema";
import { quotePrice, resolveMarkup, type FxSnapshot } from "@/pricing/engine";

export interface SyncReport {
  supplierId: string;
  /** 成功定价并上架的规格数。 */
  listed: number;
  /** 拉到了但不可售的规格数（毛利不足、缺成本价、汇率过期）。 */
  withheld: number;
  /** 每条下架原因出现的次数，便于在后台一眼看出是系统性问题还是个别商品。 */
  reasons: Record<string, number>;
  error?: string;
}

/** 从配置构造汇率快照。静态汇率用 updatedAt 作为采集时间。 */
export function fxFromConfig(context: RelayKitContext): FxSnapshot {
  const { fx } = context.config.pricing;

  if (fx.source === "static") {
    return {
      rates: fx.rates,
      // 没写 updatedAt 就当作"刚刚采集"—— 否则所有人首次部署都会因为
      // 陈旧检查而全站无货，这个失败模式太难自查了。README 里会说明
      // 建议填上 updatedAt 以便让陈旧保护真正生效。
      fetchedAt: fx.updatedAt ? new Date(fx.updatedAt) : new Date(),
    };
  }

  // coingecko 等动态源尚未接入；走到这里说明配置允许但实现未就绪，
  // 返回空汇率会让定价引擎以 missing_rate 拒绝上架 —— 这是安全的失败方向。
  return { rates: {}, fetchedAt: new Date(0) };
}

export async function syncSupplier(
  context: RelayKitContext,
  supplierId: string,
  now = new Date(),
): Promise<SyncReport> {
  const report: SyncReport = { supplierId, listed: 0, withheld: 0, reasons: {} };

  const adapter = context.suppliers.get(supplierId);
  if (!adapter) {
    return { ...report, error: `配置里没有 id 为 "${supplierId}" 的上游` };
  }

  const supplierConfig = context.config.suppliers.find((s) => s.id === supplierId);
  if (!supplierConfig) {
    return { ...report, error: `配置里没有 id 为 "${supplierId}" 的上游` };
  }

  let upstream;
  try {
    upstream = await adapter.listProducts();
  } catch (error) {
    // 上游挂了不该清空目录 —— 保留上一次的快照继续卖，比整站空货架好。
    return {
      ...report,
      error: `拉取上游商品失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const fx = fxFromConfig(context);
  const displayCurrency = context.config.store.currency;
  const syncedAt = now.toISOString();

  for (const product of upstream) {
    // 单规格商品用空串作为规格名，与表结构的约定保持一致。
    const races = product.races.length > 0 ? product.races : [""];

    for (const race of races) {
      const cost = product.costByRace[race];

      // 上游没给这个规格的拿货价。绝不能填 0 继续算 —— 那会算出一个只有
      // 加价额的售价。记一条原因让使用者知道要去上游开对接权限。
      if (cost === undefined) {
        report.withheld += 1;
        report.reasons["上游未返回该规格的拿货价"] =
          (report.reasons["上游未返回该规格的拿货价"] ?? 0) + 1;
        await upsert(context, {
          supplierId,
          code: product.code,
          race,
          name: product.name,
          cost: "0",
          price: null,
          sellable: false,
          unsellableReason: "上游未返回该规格的拿货价（可能未开放对接）",
          stock: product.stock,
          syncedAt,
        });
        continue;
      }

      const quote = quotePrice({
        cost,
        supplierCurrency: supplierConfig.currency,
        displayCurrency,
        markup: resolveMarkup(context.config.pricing, supplierId, product.code, race),
        pricing: context.config.pricing,
        fx,
        now,
      });

      // 缺货的商品即使定价成功也不上架 —— 让客户付了款才发现没货，
      // 产生的是一笔需要退款的订单和一次差评。
      const outOfStock = product.stock <= 0;
      const sellable = quote.sellable && !outOfStock;
      const reason = outOfStock ? "上游缺货" : quote.rejection?.message;

      if (sellable) {
        report.listed += 1;
      } else {
        report.withheld += 1;
        const key = outOfStock ? "上游缺货" : (quote.rejection?.code ?? "unknown");
        report.reasons[key] = (report.reasons[key] ?? 0) + 1;
      }

      await upsert(context, {
        supplierId,
        code: product.code,
        race,
        name: product.name,
        cost,
        price: sellable ? quote.price : null,
        sellable,
        unsellableReason: reason ?? null,
        stock: product.stock,
        syncedAt,
      });
    }
  }

  return report;
}

type ProductRow = typeof products.$inferInsert;

async function upsert(context: RelayKitContext, row: ProductRow): Promise<void> {
  await context.db
    .insert(products)
    .values(row)
    .onConflictDoUpdate({
      target: [products.supplierId, products.code, products.race],
      set: {
        name: row.name,
        cost: row.cost,
        price: row.price ?? null,
        sellable: row.sellable ?? false,
        unsellableReason: row.unsellableReason ?? null,
        stock: row.stock ?? 0,
        syncedAt: row.syncedAt,
      },
    });
}

/** 同步全部已配置的上游。 */
export async function syncAll(
  context: RelayKitContext,
  now = new Date(),
): Promise<SyncReport[]> {
  const reports: SyncReport[] = [];
  // 串行而非并发：上游通常是小站，几十个并发请求容易触发它的限流，
  // 而目录同步本来就不赶时间。
  for (const supplier of context.config.suppliers) {
    reports.push(await syncSupplier(context, supplier.id, now));
  }
  return reports;
}

/** 店面列表：只取可售的。 */
export async function listSellable(context: RelayKitContext) {
  return context.db.select().from(products).where(eq(products.sellable, true));
}

export async function findProduct(
  context: RelayKitContext,
  supplierId: string,
  code: string,
  race: string,
) {
  const rows = await context.db
    .select()
    .from(products)
    .where(
      and(
        eq(products.supplierId, supplierId),
        eq(products.code, code),
        eq(products.race, race),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
