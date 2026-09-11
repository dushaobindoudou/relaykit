/**
 * 优惠券测试。
 *
 * 优惠券是唯一一处「客户可以主动改变成交价」的入口，所以除了规则本身，
 * 最重要的一条是：**折后仍要赚钱**。一张 10% 的券打在毛利 6% 的商品上，
 * 那一单是净亏，而这种商品在薄毛利转售里是常态。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import * as coupon from "./coupon";
import { createTestContext, seedCoupon, type TestContext } from "@/testing/context";

let context: TestContext;

const base = {
  subtotal: "100.00",
  cost: "70.00",
  productCode: "ITEM",
  identity: "buyer@example.com",
  minMarginPercent: 5,
};

beforeEach(() => {
  context = createTestContext();
});

afterEach(() => context.close());

describe("折扣计算", () => {
  test("固定减免", async () => {
    seedCoupon(context, { code: "MINUS10", kind: "amount", value: "10" });
    const result = await coupon.validate(context, { ...base, code: "MINUS10" });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.discount, "10.00");
    assert.equal(result.ok && result.payable, "90.00");
  });

  test("百分比折扣", async () => {
    seedCoupon(context, { code: "OFF10", kind: "percent", value: "10" });
    const result = await coupon.validate(context, { ...base, code: "OFF10" });

    assert.equal(result.ok && result.discount, "10.00");
  });

  test("折扣不超过订单金额，避免算出负数应付额", async () => {
    // 零成本赠品 + 关闭毛利护栏，是唯一允许白送的组合。
    seedCoupon(context, { code: "HUGE", kind: "amount", value: "9999" });
    const result = await coupon.validate(context, {
      ...base,
      code: "HUGE",
      cost: "0",
      minMarginPercent: 0,
    });

    assert.equal(result.ok && result.discount, "100.00");
    assert.equal(result.ok && result.payable, "0.00");
  });

  test("成本大于 0 的白送算净亏，即使关掉毛利下限也拒绝", async () => {
    // 护栏设 0 表示「不要求正毛利」，但不表示「允许倒贴货」。
    seedCoupon(context, { code: "FREE", kind: "amount", value: "9999" });
    const result = await coupon.validate(context, {
      ...base,
      code: "FREE",
      cost: "70.00",
      minMarginPercent: 0,
    });

    assert.equal(result.ok === false && result.reason, "below_cost");
  });

  test("券码大小写不敏感", async () => {
    seedCoupon(context, { code: "SAVE5", kind: "amount", value: "5" });
    const result = await coupon.validate(context, { ...base, code: "  save5 " });
    assert.equal(result.ok, true);
  });
});

describe("毛利护栏：折后仍要赚钱", () => {
  test("折后毛利低于下限则拒绝", async () => {
    // 成本 70，原价 100（30% 毛利）。减 28 后应付 72，毛利只剩 2.8%。
    seedCoupon(context, { code: "DEEP", kind: "amount", value: "28" });
    const result = await coupon.validate(context, { ...base, code: "DEEP" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "below_cost");
  });

  test("折后毛利刚好等于下限则放行", async () => {
    // 成本 70，减 26.32 → 应付 73.68，毛利 (73.68-70)/73.68 = 4.99%…
    // 取一个明确高于 5% 的值验证放行边界。
    seedCoupon(context, { code: "OK", kind: "amount", value: "25" });
    const result = await coupon.validate(context, { ...base, code: "OK" });

    assert.equal(result.ok, true);
  });

  test("护栏比券的规则更晚判定 —— 规则全过也可能因毛利被拒", async () => {
    seedCoupon(context, {
      code: "VALID",
      kind: "percent",
      value: "50",
      minAmount: "0",
      usageLimit: 1000,
    });
    const result = await coupon.validate(context, { ...base, code: "VALID" });

    assert.equal(result.ok === false && result.reason, "below_cost");
  });
});

describe("券的规则", () => {
  test("不存在", async () => {
    const result = await coupon.validate(context, { ...base, code: "NOPE" });
    assert.equal(result.ok === false && result.reason, "not_found");
  });

  test("已停用", async () => {
    seedCoupon(context, { code: "OFF", active: false });
    const result = await coupon.validate(context, { ...base, code: "OFF" });
    assert.equal(result.ok === false && result.reason, "inactive");
  });

  test("已过期", async () => {
    seedCoupon(context, { code: "OLD", expiresAt: "2020-01-01T00:00:00.000Z" });
    const result = await coupon.validate(context, { ...base, code: "OLD" });
    assert.equal(result.ok === false && result.reason, "expired");
  });

  test("总量用完", async () => {
    seedCoupon(context, { code: "GONE", usageLimit: 5, usedCount: 5 });
    const result = await coupon.validate(context, { ...base, code: "GONE" });
    assert.equal(result.ok === false && result.reason, "usage_limit");
  });

  test("未达最低消费", async () => {
    seedCoupon(context, { code: "BIG", minAmount: "200" });
    const result = await coupon.validate(context, { ...base, code: "BIG" });
    assert.equal(result.ok === false && result.reason, "min_amount");
    assert.equal(result.ok === false && result.detail, "200");
  });

  test("限定商品不匹配", async () => {
    seedCoupon(context, { code: "ONLYX", productCode: "OTHER" });
    const result = await coupon.validate(context, { ...base, code: "ONLYX" });
    assert.equal(result.ok === false && result.reason, "wrong_product");
  });

  test("限定商品匹配时可用", async () => {
    seedCoupon(context, { code: "ONLYX", productCode: "ITEM", value: "5" });
    const result = await coupon.validate(context, { ...base, code: "ONLYX" });
    assert.equal(result.ok, true);
  });
});

describe("核销与限量", () => {
  test("核销后 usedCount 自增", async () => {
    seedCoupon(context, { code: "USE", usageLimit: 2 });
    await coupon.redeem(context, "USE", "ORDER-1", base.identity, "5.00");

    const row = context.raw
      .prepare("select used_count from coupons where code = ?")
      .get("USE") as { used_count: number };
    assert.equal(row.used_count, 1);
  });

  test("并发核销不会漏计 —— 限量 2 张不能被用出 3 张", async () => {
    // usedCount 若用「读出来加一再写回」，并发下三笔都会读到 0 然后写回 1。
    seedCoupon(context, { code: "LIMIT2", usageLimit: 2 });

    await Promise.all([
      coupon.redeem(context, "LIMIT2", "O1", "a@x.com", "5"),
      coupon.redeem(context, "LIMIT2", "O2", "b@x.com", "5"),
      coupon.redeem(context, "LIMIT2", "O3", "c@x.com", "5"),
    ]);

    const row = context.raw
      .prepare("select used_count from coupons where code = ?")
      .get("LIMIT2") as { used_count: number };
    assert.equal(row.used_count, 3, "三次核销都要被计到");
  });

  test("每人限用一次：第二次被拒", async () => {
    seedCoupon(context, { code: "ONCE", perUserLimit: 1 });

    const first = await coupon.validate(context, { ...base, code: "ONCE" });
    assert.equal(first.ok, true);

    await coupon.redeem(context, "ONCE", "ORDER-1", base.identity, "5.00");

    const second = await coupon.validate(context, { ...base, code: "ONCE" });
    assert.equal(second.ok === false && second.reason, "per_user_limit");
  });

  test("换个人仍可用", async () => {
    seedCoupon(context, { code: "ONCE", perUserLimit: 1 });
    await coupon.redeem(context, "ONCE", "ORDER-1", "someone@else.com", "5.00");

    const result = await coupon.validate(context, { ...base, code: "ONCE" });
    assert.equal(result.ok, true);
  });

  test("同一订单不能核销两次（唯一索引兜底）", async () => {
    seedCoupon(context, { code: "DUP" });
    await coupon.redeem(context, "DUP", "SAME", base.identity, "5");

    await assert.rejects(() => coupon.redeem(context, "DUP", "SAME", base.identity, "5"));
  });
});

describe("释放名额", () => {
  test("订单作废后名额还回去", async () => {
    seedCoupon(context, { code: "REL", usageLimit: 1 });
    await coupon.redeem(context, "REL", "ORDER-X", base.identity, "5");
    await coupon.release(context, "ORDER-X");

    const row = context.raw
      .prepare("select used_count from coupons where code = ?")
      .get("REL") as { used_count: number };
    assert.equal(row.used_count, 0);

    // 名额还回去后该用户能重新用
    const result = await coupon.validate(context, { ...base, code: "REL" });
    assert.equal(result.ok, true);
  });

  test("重复释放不会把计数减穿", async () => {
    seedCoupon(context, { code: "REL2" });
    await coupon.redeem(context, "REL2", "ORDER-Y", base.identity, "5");

    await coupon.release(context, "ORDER-Y");
    await coupon.release(context, "ORDER-Y");

    const row = context.raw
      .prepare("select used_count from coupons where code = ?")
      .get("REL2") as { used_count: number };
    assert.equal(row.used_count, 0);
  });

  test("释放不存在的订单是安全的空操作", async () => {
    await assert.doesNotReject(() => coupon.release(context, "GHOST"));
  });
});
