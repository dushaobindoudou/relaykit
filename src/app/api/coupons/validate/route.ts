/** 下单前校验优惠码，返回可减免额。真正的核销在下单时再做一次。 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { resolveSession, SESSION_COOKIE } from "@/accounts/auth";
import { findProduct } from "@/catalog/sync";
import { resolveUnitPrice } from "@/orders/service";
import * as coupon from "@/pricing/coupon";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const context = result.context;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  const product = await findProduct(
    context,
    str(body.supplierId),
    // 前端字段名避开与 coupon code 冲突，这里还原
    str(body.code_),
    str(body.race),
  );
  if (!product || !product.sellable || product.price === null) {
    return Response.json({ ok: false, error: "商品不可售" }, { status: 400 });
  }

  const quantity = Math.max(1, Number(body.quantity) || 1);
  const unit = resolveUnitPrice(product, quantity);
  const user = await resolveSession(
    context,
    (await cookies()).get(SESSION_COOKIE)?.value,
  );

  const check = await coupon.validate(context, {
    code: str(body.code),
    subtotal: (Number(unit) * quantity).toFixed(2),
    cost: (Number(product.cost) * quantity).toFixed(2),
    productCode: product.code,
    identity: user?.id ?? str(body.email).toLowerCase(),
    minMarginPercent: context.config.pricing.minMarginPercent,
  });

  if (!check.ok) {
    const messages: Record<string, string> = {
      not_found: "优惠码不存在",
      inactive: "该优惠码已停用",
      expired: "该优惠码已过期",
      usage_limit: "该优惠码已被领完",
      per_user_limit: "你已使用过该优惠码",
      min_amount: `订单金额需满 ${check.detail} 才能使用`,
      wrong_product: "该优惠码不适用于此商品",
      // 不暴露「毛利不足」—— 那是我们的成本信息。
      below_cost: "该优惠码不适用于此商品",
    };
    return Response.json(
      { ok: false, error: messages[check.reason] ?? "优惠码不可用" },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, discount: check.discount, payable: check.payable });
}
