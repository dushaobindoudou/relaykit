/**
 * 优惠券。
 *
 * 上游的对接协议不提供优惠券 —— 那是它对自己客户的功能。所以这里是我们
 * 自己的规则，好处是完全可控，代价是**折扣直接吃我们的毛利**：
 * 一张 10% 的券作用在毛利 6% 的商品上，那单是净亏。
 * 因此 validate() 会同时校验券的规则与成交后的毛利，两道都要过。
 */

import { Decimal } from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { couponRedemptions, coupons, type Coupon } from "@/db/schema";
import type { BuyRelayContext } from "@/runtime/context";

export type CouponRejection =
  | "not_found"
  | "inactive"
  | "expired"
  | "usage_limit"
  | "per_user_limit"
  | "min_amount"
  | "wrong_product"
  | "below_cost";

export type CouponCheck =
  | { ok: true; coupon: Coupon; discount: string; payable: string }
  | { ok: false; reason: CouponRejection; detail?: string };

export interface CouponContext {
  code: string;
  /** 未折扣前的订单总额。 */
  subtotal: string;
  /** 该订单的进货总成本（展示币）。用于毛利护栏。 */
  cost: string;
  productCode: string;
  /** 登录用户为 userId，匿名下单为邮箱。用于 perUserLimit。 */
  identity: string;
  /** 折后最低毛利率，通常取配置里的 minMarginPercent。 */
  minMarginPercent: number;
  now?: Date;
}

function computeDiscount(coupon: Coupon, subtotal: Decimal): Decimal {
  const raw =
    coupon.kind === "percent"
      ? subtotal.mul(new Decimal(coupon.value)).div(100)
      : new Decimal(coupon.value);

  // 折扣不能超过订单金额本身，否则会算出负数应付额。
  return Decimal.min(raw, subtotal).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

export async function validate(
  context: BuyRelayContext,
  input: CouponContext,
): Promise<CouponCheck> {
  const now = input.now ?? new Date();
  const code = input.code.trim().toUpperCase();

  const rows = await context.db
    .select()
    .from(coupons)
    .where(eq(coupons.code, code))
    .limit(1);

  const coupon = rows[0];
  if (!coupon) return { ok: false, reason: "not_found" };
  if (!coupon.active) return { ok: false, reason: "inactive" };

  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return { ok: false, reason: "expired" };
  }

  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: "usage_limit" };
  }

  if (coupon.productCode && coupon.productCode !== input.productCode) {
    return { ok: false, reason: "wrong_product" };
  }

  const subtotal = new Decimal(input.subtotal);
  if (subtotal.lt(new Decimal(coupon.minAmount))) {
    return {
      ok: false,
      reason: "min_amount",
      detail: coupon.minAmount,
    };
  }

  if (coupon.perUserLimit !== null) {
    const used = await context.db
      .select({ total: sql<number>`count(*)` })
      .from(couponRedemptions)
      .where(
        and(
          eq(couponRedemptions.code, code),
          eq(couponRedemptions.identity, input.identity),
        ),
      );
    if (Number(used[0]?.total ?? 0) >= coupon.perUserLimit) {
      return { ok: false, reason: "per_user_limit" };
    }
  }

  const discount = computeDiscount(coupon, subtotal);
  const payable = subtotal.minus(discount);

  // —— 毛利护栏 ——
  // 券的规则全都通过，不代表这一单还赚钱。折后毛利低于下限就拒绝，
  // 宁可少一单也不做亏本生意。
  const cost = new Decimal(input.cost);

  // 应付额为 0 时毛利率无定义（分母为零），按是否真的亏货来判：
  // 成本也是 0 的赠品不算亏（毛利 0）；成本大于 0 的白送就是净亏。
  const margin = payable.isZero()
    ? cost.isZero()
      ? new Decimal(0)
      : new Decimal(-100)
    : payable.minus(cost).div(payable).mul(100);

  if (margin.lt(input.minMarginPercent)) {
    return {
      ok: false,
      reason: "below_cost",
      detail: margin.toFixed(2),
    };
  }

  return {
    ok: true,
    coupon,
    discount: discount.toFixed(2),
    payable: payable.toFixed(2),
  };
}

/**
 * 核销。必须在订单创建成功之后调用。
 *
 * usedCount 用 SQL 自增而不是「读出来加一再写回」—— 后者在并发下会漏计，
 * 导致限量 100 张的券被用出 120 张。
 */
export async function redeem(
  context: BuyRelayContext,
  code: string,
  orderId: string,
  identity: string,
  discount: string,
): Promise<void> {
  const normalized = code.trim().toUpperCase();

  await context.db.batch([
    context.db
      .update(coupons)
      .set({ usedCount: sql`${coupons.usedCount} + 1` })
      .where(eq(coupons.code, normalized)),
    context.db.insert(couponRedemptions).values({
      code: normalized,
      orderId,
      identity,
      discount,
      createdAt: new Date().toISOString(),
    }),
  ]);
}

/** 订单作废时回滚核销，把名额还回去。 */
export async function release(
  context: BuyRelayContext,
  orderId: string,
): Promise<void> {
  const rows = await context.db
    .select()
    .from(couponRedemptions)
    .where(eq(couponRedemptions.orderId, orderId))
    .limit(1);

  const redemption = rows[0];
  if (!redemption) return;

  await context.db.batch([
    context.db
      .update(coupons)
      // 不能减到负数：重复调用 release 会把计数减穿。
      .set({ usedCount: sql`max(0, ${coupons.usedCount} - 1)` })
      .where(eq(coupons.code, redemption.code)),
    context.db
      .delete(couponRedemptions)
      .where(eq(couponRedemptions.orderId, orderId)),
  ]);
}
