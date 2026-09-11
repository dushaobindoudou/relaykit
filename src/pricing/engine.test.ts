/**
 * 定价引擎测试。
 *
 * 这里的每个用例都对应一种"会亏钱"或"会算错钱"的现实情形，而不是为了覆盖率。
 * 重点在三类护栏：成本不可信、汇率不可信、毛利被吃穿。
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  applyMarkup,
  quotePrice,
  resolveMarkup,
  resolveRate,
  roundPrice,
  type FxSnapshot,
  type PriceInput,
} from "./engine";
import type { PricingConfig } from "@/config/schema";
import { Decimal } from "decimal.js";

const NOW = new Date("2026-09-11T00:00:00Z");

const freshFx = (rates: Record<string, string>): FxSnapshot => ({
  rates,
  fetchedAt: new Date(NOW.getTime() - 60_000), // 一分钟前，肯定不算陈旧
});

const basePricing = (overrides: Partial<PricingConfig> = {}): PricingConfig => ({
  fx: { source: "static", rates: { CNY_USDT: "0.1389" } },
  markup: { type: "fixed", amount: "1" },
  minMarginPercent: 3,
  maxDriftPercent: 10,
  maxStalenessHours: 24,
  rounding: { mode: "up", increment: "0.01" },
  overrides: [],
  ...overrides,
});

const input = (overrides: Partial<PriceInput> = {}): PriceInput => ({
  cost: "30",
  supplierCurrency: "CNY",
  displayCurrency: "USDT",
  markup: { type: "fixed", amount: "1" },
  pricing: basePricing(),
  fx: freshFx({ CNY_USDT: "0.1389" }),
  now: NOW,
  ...overrides,
});

describe("resolveRate", () => {
  test("同币种返回 1，不需要配置汇率", () => {
    assert.equal(resolveRate({}, "USDT", "USDT")?.toString(), "1");
  });

  test("直接命中", () => {
    assert.equal(resolveRate({ CNY_USDT: "0.14" }, "CNY", "USDT")?.toString(), "0.14");
  });

  test("反向汇率自动取倒数，省得两个方向都配一遍", () => {
    const rate = resolveRate({ USDT_CNY: "7.2" }, "CNY", "USDT");
    assert.equal(rate?.toFixed(6), "0.138889");
  });

  test("反向汇率为 0 时返回 null 而不是 Infinity（否则会算出无穷大的售价）", () => {
    assert.equal(resolveRate({ USDT_CNY: "0" }, "CNY", "USDT"), null);
  });

  test("查不到返回 null", () => {
    assert.equal(resolveRate({}, "CNY", "USDT"), null);
  });
});

describe("roundPrice", () => {
  test("up 模式向上取整到 increment —— 薄毛利场景下不能向下抹零", () => {
    assert.equal(roundPrice(new Decimal("5.161"), "up", "0.01").toFixed(), "5.17");
  });

  test("up 模式对已经是整数倍的值不再加一档", () => {
    assert.equal(roundPrice(new Decimal("5.16"), "up", "0.01").toFixed(), "5.16");
  });

  test("nearest 模式四舍五入", () => {
    assert.equal(roundPrice(new Decimal("5.164"), "nearest", "0.01").toFixed(), "5.16");
    assert.equal(roundPrice(new Decimal("5.165"), "nearest", "0.01").toFixed(), "5.17");
  });

  test("支持非 0.01 的档位，例如整数定价", () => {
    assert.equal(roundPrice(new Decimal("5.01"), "up", "1").toFixed(), "6");
  });
});

describe("applyMarkup", () => {
  test("fixed 是在**换算之后**的展示币上加，所以 1 就是 1 USDT", () => {
    assert.equal(applyMarkup(new Decimal("4.167"), { type: "fixed", amount: "1" }).toFixed(), "5.167");
  });

  test("percent 按成本的百分比加", () => {
    assert.equal(applyMarkup(new Decimal("100"), { type: "percent", amount: "15" }).toFixed(), "115");
  });
});

describe("resolveMarkup", () => {
  const pricing = basePricing({
    markup: { type: "fixed", amount: "1" },
    overrides: [
      { supplier: "primary", code: "A", markup: { type: "percent", amount: "20" } },
      {
        supplier: "primary",
        code: "A",
        race: "1年",
        markup: { type: "percent", amount: "35" },
      },
      { supplier: "other", code: "A", markup: { type: "percent", amount: "99" } },
    ],
  });

  test("没有匹配时用默认加价", () => {
    assert.deepEqual(resolveMarkup(pricing, "primary", "ZZZ"), {
      type: "fixed",
      amount: "1",
    });
  });

  test("按 code 匹配", () => {
    assert.deepEqual(resolveMarkup(pricing, "primary", "A"), {
      type: "percent",
      amount: "20",
    });
  });

  test("带 race 的规则比只匹配 code 的更具体，优先生效", () => {
    assert.deepEqual(resolveMarkup(pricing, "primary", "A", "1年"), {
      type: "percent",
      amount: "35",
    });
  });

  test("race 不匹配时回落到 code 级规则，而不是默认规则", () => {
    assert.deepEqual(resolveMarkup(pricing, "primary", "A", "首登"), {
      type: "percent",
      amount: "20",
    });
  });

  test("不同 supplier 的同名 code 互不干扰", () => {
    assert.deepEqual(resolveMarkup(pricing, "other", "A"), {
      type: "percent",
      amount: "99",
    });
  });
});

describe("quotePrice：正常路径", () => {
  test("成本换算 → 加价 → 向上取整，各步都能从返回值里复现", () => {
    // 30 CNY × 0.1389 = 4.167 USDT，加 1 = 5.167，向上取整 → 5.17
    const quote = quotePrice(input());

    assert.equal(quote.sellable, true);
    assert.equal(quote.price, "5.17");
    assert.equal(quote.costInDisplayCurrency, "4.167");
    assert.equal(quote.grossProfit, "1.003");
    assert.equal(quote.rateUsed, "0.1389");
  });

  test("毛利率的分母是售价而非成本（口径要能对上后台报表）", () => {
    const quote = quotePrice(input());
    // 1.003 / 5.17 = 19.4004...%
    assert.equal(quote.grossMarginPercent.startsWith("19.40"), true);
  });

  test("上游与店铺同币种时无需汇率，直接加价", () => {
    const quote = quotePrice(
      input({
        supplierCurrency: "USDT",
        cost: "10",
        fx: freshFx({}),
      }),
    );
    assert.equal(quote.sellable, true);
    assert.equal(quote.price, "11");
  });

  test("percent 加价路径", () => {
    const quote = quotePrice(
      input({
        supplierCurrency: "USDT",
        cost: "100",
        markup: { type: "percent", amount: "15" },
        fx: freshFx({}),
      }),
    );
    assert.equal(quote.price, "115");
  });
});

describe("quotePrice：成本不可信", () => {
  test("成本为 0 时拒绝定价 —— 上游漏返 factory_price 的典型表现", () => {
    // 若不拦，售价会等于加价额本身（1 USDT），卖一单赔一单货。
    const quote = quotePrice(input({ cost: "0" }));
    assert.equal(quote.sellable, false);
    assert.equal(quote.rejection?.code, "invalid_cost");
  });

  test("负成本同样拒绝", () => {
    assert.equal(quotePrice(input({ cost: "-5" })).rejection?.code, "invalid_cost");
  });

  test("非数字成本不抛异常，而是返回不可售（单个坏商品不该拖垮整次同步）", () => {
    const quote = quotePrice(input({ cost: "N/A" }));
    assert.equal(quote.sellable, false);
    assert.equal(quote.rejection?.code, "invalid_cost");
  });
});

describe("quotePrice：汇率不可信", () => {
  test("缺汇率时拒绝定价，而不是按 1:1 蒙混过去", () => {
    const quote = quotePrice(input({ fx: freshFx({}) }));
    assert.equal(quote.sellable, false);
    assert.equal(quote.rejection?.code, "missing_rate");
  });

  test("汇率超过 maxStalenessHours 未更新则停售", () => {
    const quote = quotePrice(
      input({
        fx: {
          rates: { CNY_USDT: "0.1389" },
          fetchedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        },
      }),
    );
    assert.equal(quote.sellable, false);
    assert.equal(quote.rejection?.code, "stale_rate");
  });

  test("刚好在窗口内的汇率仍可用（边界不应误杀）", () => {
    const quote = quotePrice(
      input({
        fx: {
          rates: { CNY_USDT: "0.1389" },
          fetchedAt: new Date(NOW.getTime() - 23.9 * 60 * 60 * 1000),
        },
      }),
    );
    assert.equal(quote.sellable, true);
  });

  test("maxStalenessHours 为 0 表示不检查，供本地开发使用", () => {
    const quote = quotePrice(
      input({
        pricing: basePricing({ maxStalenessHours: 0 }),
        fx: {
          rates: { CNY_USDT: "0.1389" },
          fetchedAt: new Date("2020-01-01T00:00:00Z"),
        },
      }),
    );
    assert.equal(quote.sellable, true);
  });
});

describe("quotePrice：毛利护栏", () => {
  test("固定加价在高客单商品上被稀释到护栏以下，此时停售", () => {
    // 固定加价的毛利率随客单价上升而下降：同样加 1 USDT，
    //   成本 18 CNY（≈2.5 USDT）→ 毛利约 28%
    //   成本 116 CNY（≈16.1 USDT）→ 毛利约 5.9%
    // 店主若把护栏设到 10%（低于这个数链上手续费就吃光了），高客单商品应当被拦下。
    const strict = basePricing({ minMarginPercent: 10 });

    const cheap = quotePrice(input({ cost: "18", pricing: strict }));
    assert.equal(cheap.sellable, true);

    const pricey = quotePrice(input({ cost: "116", pricing: strict }));
    assert.equal(pricey.sellable, false);
    assert.equal(pricey.rejection?.code, "margin_too_low");
    // 即使不可售也要把算出来的价格与毛利带回去，后台才能显示"差多少才够"。
    assert.notEqual(pricey.price, "0");
    assert.equal(pricey.grossMarginPercent.startsWith("5.8"), true);
  });

  test("护栏设为 0 时不拦截（配置层会对此发出警告）", () => {
    const quote = quotePrice(
      input({
        cost: "116",
        markup: { type: "fixed", amount: "0.01" },
        pricing: basePricing({ minMarginPercent: 0 }),
      }),
    );
    assert.equal(quote.sellable, true);
  });

  test("毛利恰好等于护栏值时放行（用 >= 而不是 >）", () => {
    // 成本 100 USDT、加价 percent 使毛利率正好 3%
    const quote = quotePrice(
      input({
        supplierCurrency: "USDT",
        cost: "97",
        markup: { type: "fixed", amount: "3" },
        pricing: basePricing({ minMarginPercent: 3 }),
        fx: freshFx({}),
      }),
    );
    assert.equal(quote.grossMarginPercent.startsWith("3.0000"), true);
    assert.equal(quote.sellable, true);
  });

  test("负加价把售价压到成本以下时，毛利为负并被拦下", () => {
    const quote = quotePrice(
      input({
        supplierCurrency: "USDT",
        cost: "10",
        markup: { type: "fixed", amount: "-2" },
        fx: freshFx({}),
      }),
    );
    assert.equal(quote.sellable, false);
    assert.equal(quote.rejection?.code, "margin_too_low");
    assert.equal(quote.grossProfit.startsWith("-"), true);
  });
});

describe("quotePrice：精度", () => {
  test("不使用浮点：0.1 + 0.2 类的误差不会出现在售价里", () => {
    const quote = quotePrice(
      input({
        supplierCurrency: "USDT",
        cost: "0.1",
        markup: { type: "fixed", amount: "0.2" },
        pricing: basePricing({ minMarginPercent: 0, rounding: { mode: "nearest", increment: "0.000001" } }),
        fx: freshFx({}),
      }),
    );
    assert.equal(quote.price, "0.3");
  });

  test("大数量级不丢精度", () => {
    const quote = quotePrice(
      input({
        supplierCurrency: "USDT",
        cost: "123456789.123456",
        markup: { type: "fixed", amount: "1" },
        pricing: basePricing({ rounding: { mode: "up", increment: "0.000001" } }),
        fx: freshFx({}),
      }),
    );
    assert.equal(quote.price, "123456790.123456");
  });
});
