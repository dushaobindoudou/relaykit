/**
 * 定价引擎：上游成本价 → 面向客户的售价。
 *
 * 整个文件是纯函数，不碰 IO、不读时钟（"现在"由调用方传入）—— 定价是唯一
 * 会直接决定赚钱还是赔钱的逻辑，必须能被穷举测试。
 *
 * 金额一律走 Decimal，任何一处退化成 number 都会在累计几千单之后变成对不上的账。
 */

import { Decimal } from "decimal.js";

import type { MarkupConfig, PricingConfig } from "../config/schema";

// 银行家舍入在金额场景下会让"向上取整保毛利"的意图落空，显式关掉。
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface FxSnapshot {
  /** 形如 { CNY_USDT: "0.1389" }，含义是「1 CNY = 0.1389 USDT」。 */
  rates: Record<string, string>;
  /** 这份汇率的采集时间。用于判断是否已经陈旧到不可信。 */
  fetchedAt: Date;
}

export interface PriceInput {
  /** 上游报给我们的进货价，以 supplierCurrency 计。 */
  cost: string;
  supplierCurrency: string;
  /** 店铺展示与结算的币种。 */
  displayCurrency: string;
  /** 该商品适用的加价规则（已经过 overrides 解析）。 */
  markup: MarkupConfig;
  pricing: PricingConfig;
  fx: FxSnapshot;
  /** 由调用方注入，便于测试陈旧汇率。 */
  now: Date;
}

export type PriceRejection =
  /** 缺汇率，无法换算。 */
  | { code: "missing_rate"; message: string }
  /** 汇率太旧，不可信。继续卖等于拿老汇率赌行情。 */
  | { code: "stale_rate"; message: string }
  /** 毛利低于护栏。通常是上游涨价或汇率跳动，应当下架而不是硬卖。 */
  | { code: "margin_too_low"; message: string }
  /** 成本本身不合法（上游漏返 factory_price 时会是 0 或负数）。 */
  | { code: "invalid_cost"; message: string };

export interface PriceQuote {
  /** 最终售价，以 displayCurrency 计，已按 rounding 规则取整。 */
  price: string;
  /** 换算到 displayCurrency 的成本，用于展示毛利与对账。 */
  costInDisplayCurrency: string;
  /** 售价 − 成本。 */
  grossProfit: string;
  /** 毛利率 = (售价 − 成本) / 售价 × 100。注意分母是**售价**不是成本。 */
  grossMarginPercent: string;
  /** 用到的汇率，落库后可复现历史定价。 */
  rateUsed: string;
  /** 为 false 时 rejection 必有值，商品应当下架。 */
  sellable: boolean;
  rejection?: PriceRejection;
}

/** 汇率查找：支持直接命中与倒数回退（配了 CNY_USDT 就不必再配 USDT_CNY）。 */
export function resolveRate(
  rates: Record<string, string>,
  from: string,
  to: string,
): Decimal | null {
  if (from === to) return new Decimal(1);

  const direct = rates[`${from}_${to}`];
  if (direct !== undefined) return new Decimal(direct);

  const inverse = rates[`${to}_${from}`];
  if (inverse !== undefined) {
    const value = new Decimal(inverse);
    // 0 取倒数会得到 Infinity，进而算出无穷大的售价。挡住。
    if (value.isZero()) return null;
    return new Decimal(1).div(value);
  }

  return null;
}

/**
 * 按 increment 取整。
 *
 * 默认 up：宁可贵一分钱也不少赚 —— 向下取整在高频小单场景下会把
 * 本来就很薄的毛利磨掉。nearest 留给对价格美观有要求的场景。
 */
export function roundPrice(
  value: Decimal,
  mode: "up" | "nearest",
  increment: string,
): Decimal {
  const step = new Decimal(increment);
  if (step.isZero()) return value;

  const units = value.div(step);
  const rounded = mode === "up" ? units.ceil() : units.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return rounded.mul(step);
}

/** 应用加价规则。fixed 以 displayCurrency 计，所以必须在换算之后调用。 */
export function applyMarkup(costInDisplay: Decimal, markup: MarkupConfig): Decimal {
  if (markup.type === "fixed") {
    return costInDisplay.plus(new Decimal(markup.amount));
  }
  return costInDisplay.mul(new Decimal(100).plus(markup.amount).div(100));
}

/**
 * 手动收款渠道（支付宝/微信转账）的客户单价。
 *
 * 商品表里的 price 是同步时按默认加价烘出来的链上售价；人工对账的单
 * 要按**成本口径重算**（如 30%），不能在售价上打补丁 —— 打补丁会被
 * 优惠券、阶梯价来回放大。阶梯折扣以「该档售价 ÷ 基础售价」的比例
 * 保持原形状，买得多依旧更便宜。
 */
export function manualUnitPrice(input: {
  /** 上游成本（上游结算币种，如 CNY）。 */
  cost: string | number;
  /** 基础零售价（数量 1 的链上售价，含默认加价），用作阶梯比例的分母。 */
  baseRetailPrice: string | number;
  /** 当前数量档的链上售价。 */
  tierUnitPrice: string | number;
  rates: Record<string, string>;
  /** 上游结算币种 → 店铺展示币种。 */
  fromCurrency: string;
  toCurrency: string;
  /** 人工渠道的加价（成本口径百分比，如 "30"）。 */
  markupPercent: string;
  rounding: { mode: "up" | "nearest"; increment: string };
}): string {
  const rate = resolveRate(input.rates, input.fromCurrency, input.toCurrency);
  if (rate === null) {
    throw new Error(`缺少汇率 ${input.fromCurrency}_${input.toCurrency}，无法计算手动收款价格`);
  }
  const costInDisplay = new Decimal(input.cost).mul(rate);
  const base = applyMarkup(costInDisplay, {
    type: "percent",
    amount: input.markupPercent,
  });

  const baseRetail = new Decimal(input.baseRetailPrice);
  const tierRatio = baseRetail.isZero()
    ? new Decimal(1)
    : new Decimal(input.tierUnitPrice).div(baseRetail);

  return roundPrice(base.mul(tierRatio), input.rounding.mode, input.rounding.increment).toFixed(2);
}

/** 展示币种金额换算成收款币种金额（向上取整到分）—— 人工收款单显示 ¥ 用。 */
export function convertAmount(
  amount: string | number,
  rates: Record<string, string>,
  from: string,
  to: string,
): string {
  const rate = resolveRate(rates, from, to);
  if (rate === null) {
    throw new Error(`缺少汇率 ${from}_${to}，无法换算收款金额`);
  }
  return new Decimal(amount).mul(rate).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2);
}

/** 从 overrides 里挑出适用于该商品的加价规则，没有则用默认值。 */
export function resolveMarkup(
  pricing: PricingConfig,
  supplierId: string,
  code: string,
  race?: string,
): MarkupConfig {
  // 带 race 的规则更具体，优先于只匹配 code 的规则。
  const candidates = pricing.overrides.filter(
    (item) => item.supplier === supplierId && item.code === code,
  );

  const exact = candidates.find((item) => item.race !== undefined && item.race === race);
  if (exact) return exact.markup;

  const wildcard = candidates.find((item) => item.race === undefined);
  if (wildcard) return wildcard.markup;

  return pricing.markup;
}

function reject(input: PriceInput, rejection: PriceRejection): PriceQuote {
  return {
    price: "0",
    costInDisplayCurrency: "0",
    grossProfit: "0",
    grossMarginPercent: "0",
    rateUsed: "0",
    sellable: false,
    rejection,
  };
}

export function quotePrice(input: PriceInput): PriceQuote {
  const { pricing, fx } = input;

  let cost: Decimal;
  try {
    cost = new Decimal(input.cost);
  } catch {
    return reject(input, {
      code: "invalid_cost",
      message: `成本价 "${input.cost}" 不是合法数字`,
    });
  }

  // 上游漏返 factory_price 时这里会是 0。绝不能当成"白拿的货"继续算价 ——
  // 那会算出一个只有加价额的售价，卖一单赔一单。
  if (!cost.isFinite() || cost.lte(0)) {
    return reject(input, {
      code: "invalid_cost",
      message: `成本价为 ${input.cost}，上游可能未返回 factory_price，拒绝定价`,
    });
  }

  const rate = resolveRate(fx.rates, input.supplierCurrency, input.displayCurrency);
  if (rate === null || !rate.isFinite() || rate.lte(0)) {
    return reject(input, {
      code: "missing_rate",
      message: `缺少 ${input.supplierCurrency} → ${input.displayCurrency} 的汇率`,
    });
  }

  // 陈旧汇率：静态汇率不会自己更新，跌出窗口就必须停售而不是按老价继续卖。
  // maxStalenessHours 为 0 表示不检查（本地开发用）。
  if (pricing.maxStalenessHours > 0) {
    const ageHours =
      (input.now.getTime() - fx.fetchedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > pricing.maxStalenessHours) {
      return reject(input, {
        code: "stale_rate",
        message:
          `汇率已 ${ageHours.toFixed(1)} 小时未更新，超过上限 ${pricing.maxStalenessHours} 小时。` +
          `更新 pricing.fx 后才会恢复上架。`,
      });
    }
  }

  const costInDisplay = cost.mul(rate);
  const marked = applyMarkup(costInDisplay, input.markup);
  const price = roundPrice(marked, pricing.rounding.mode, pricing.rounding.increment);

  const grossProfit = price.minus(costInDisplay);
  // 售价为 0 时（加价配成了负数把价格压没了）不能拿它做分母。
  const grossMarginPercent = price.isZero()
    ? new Decimal(0)
    : grossProfit.div(price).mul(100);

  const quote: Omit<PriceQuote, "sellable" | "rejection"> = {
    price: price.toFixed(),
    costInDisplayCurrency: costInDisplay.toFixed(),
    grossProfit: grossProfit.toFixed(),
    grossMarginPercent: grossMarginPercent.toFixed(4),
    rateUsed: rate.toFixed(),
  };

  if (grossMarginPercent.lt(pricing.minMarginPercent)) {
    return {
      ...quote,
      sellable: false,
      rejection: {
        code: "margin_too_low",
        message:
          `毛利率 ${grossMarginPercent.toFixed(2)}% 低于下限 ${pricing.minMarginPercent}%` +
          `（成本 ${costInDisplay.toFixed(4)}，售价 ${price.toFixed()}）。` +
          `通常是上游涨价或汇率变动，请调整加价或下架该商品。`,
      },
    };
  }

  return { ...quote, sellable: true };
}
