/**
 * 汇率快照 —— 动态源（settings 缓存）+ 配置静态值兜底。
 *
 * 配置文件里的静态汇率（fx.updatedAt 手工维护）只是兜底：静态值的
 * 时间戳一过 maxStalenessHours，健康检查会把全站商品下架 —— 指望
 * 店主记得改配置重新部署来"续命"是坏的失败模式。
 *
 * 取值顺序（**仅当 fx.source = "coingecko"**）：
 *   1. settings 表的 fx_rates 缓存（cron 每 15 分钟刷新）—— 新鲜就用
 *   2. 缓存过期/缺失时现场抓一次并写回（自愈，不依赖 cron 醒着）
 *   3. 抓取失败 → 空汇率 → 定价引擎以 missing_rate 拒绝上架
 *      —— 宁可下架也不卖亏钱的价
 *
 * fx.source = "static" 时**完全不碰 settings 和网络**：行为与历史版本
 * 一致（单元测试的确定性依赖这一点），动态汇率是显式的配置选择。
 *
 * 汇率口径：CNY_USDT = 1 CNY 值多少 USDT。
 *   - CoinGecko：tether 的 CNY 价 p → 1/p
 *   - er-api 兜底：USD 基准的 CNY 价 c → USDT≈USD → 1/c
 */

import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";

import { settings } from "@/db/schema";
import type { BuyRelayContext } from "@/runtime/context";

const FX_KEY = "fx_rates";
/** 与健康检查的陈旧阈值一致。 */
export const FX_MAX_AGE_MS = 24 * 3_600_000;

export interface FxSnapshot {
  rates: Record<string, string>;
  fetchedAt: Date;
  /** 汇率来源：settings 缓存 / 现场抓取 / 配置静态值。 */
  origin: "cache" | "fresh" | "static";
}

interface StoredFx {
  CNY_USDT: string;
  fetchedAt: string;
}

function rateIsValid(value: string): boolean {
  try {
    const rate = new Decimal(value);
    // CNY_USDT 合理区间 ≈ 0.12~0.15；离谱值说明源坏了，别信。
    return rate.gt(0.01) && rate.lt(1);
  } catch {
    return false;
  }
}

/** 现场抓 CNY→USDT。两个源，CoinGecko 优先。 */
export async function fetchCnyUsdt(): Promise<{ rate: string; source: string }> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cny",
      { signal: AbortSignal.timeout(8_000) },
    );
    if (response.ok) {
      const data = (await response.json()) as { tether?: { cny?: number } };
      const cny = data.tether?.cny;
      if (cny && cny > 1) {
        return {
          rate: new Decimal(1).div(new Decimal(cny)).toDecimalPlaces(6).toString(),
          source: "coingecko",
        };
      }
    }
  } catch {
    // 落到下一个源。
  }

  const response = await fetch("https://open.er-api.com/v6/latest/USD", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`er-api HTTP ${response.status}`);
  const data = (await response.json()) as { rates?: Record<string, number> };
  const cnyPerUsd = data.rates?.CNY;
  if (!cnyPerUsd || cnyPerUsd < 1) throw new Error("er-api 缺少 CNY 价");
  return {
    rate: new Decimal(1).div(new Decimal(cnyPerUsd)).toDecimalPlaces(6).toString(),
    source: "er-api",
  };
}

async function saveFx(
  db: BuyRelayContext["db"],
  rate: string,
  now: Date,
): Promise<void> {
  const payload: StoredFx = { CNY_USDT: rate, fetchedAt: now.toISOString() };
  const value = JSON.stringify(payload);
  await db
    .insert(settings)
    .values({ key: FX_KEY, value, updatedAt: now.toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now.toISOString() },
    });
}

/** 抓取并写回 settings。cron 与请求路径的自愈共用。 */
export async function refreshFx(
  db: BuyRelayContext["db"],
  now = new Date(),
): Promise<{ rate: string; source: string }> {
  const { rate, source } = await fetchCnyUsdt();
  await saveFx(db, rate, now);
  return { rate, source };
}

/** 汇率快照：动态源走 缓存→自愈→失败拒绝上架；静态源原样返回配置值。 */
export async function fxSnapshot(context: BuyRelayContext, now = new Date()): Promise<FxSnapshot> {
  const fx = context.config.pricing.fx;

  if (fx.source === "static") {
    return {
      rates: fx.rates,
      // 没写 updatedAt 就当作"刚刚采集"—— 否则所有人首次部署都会因为
      // 陈旧检查而全站无货，这个失败模式太难自查了。
      fetchedAt: fx.updatedAt ? new Date(fx.updatedAt) : now,
      origin: "static",
    };
  }

  // source = "coingecko"：动态模式。
  try {
    const rows = await context.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, FX_KEY))
      .limit(1);
    const row = rows[0];
    if (row) {
      const stored = JSON.parse(row.value) as StoredFx;
      if (rateIsValid(stored.CNY_USDT)) {
        const fetchedAt = new Date(stored.fetchedAt);
        if (now.getTime() - fetchedAt.getTime() <= FX_MAX_AGE_MS) {
          return { rates: { CNY_USDT: stored.CNY_USDT }, fetchedAt, origin: "cache" };
        }
      }
    }

    // 缓存缺失/过期：现场抓一次（自愈）。失败则空汇率（拒绝上架）。
    const { rate } = await refreshFx(context.db, now);
    if (rateIsValid(rate)) {
      return { rates: { CNY_USDT: rate }, fetchedAt: now, origin: "fresh" };
    }
  } catch {
    // settings 不可用或抓取失败：走空汇率的安全失败方向。
  }

  return { rates: {}, fetchedAt: new Date(0), origin: "static" };
}
