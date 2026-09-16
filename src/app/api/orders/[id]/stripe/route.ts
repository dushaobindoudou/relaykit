/**
 * Stripe Checkout 跳转。
 *
 * POST /api/orders/{id}/stripe → 303 到 Stripe 托管收银台。
 * 订单页用普通表单提交到这来，零 JS；订单号即对账标识
 * （client_reference_id + metadata 双写）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { getOrder } from "@/orders/service";
import { createCheckoutSession } from "@/payments/stripe";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.redirect(new URL("/", _request.url), 303);
  }
  const context = result.context;

  const secretKey = env.STRIPE_SECRET_KEY ?? "";
  const stripeConfig = context.config.payments.stripe;
  if (!stripeConfig?.enabled || !secretKey) {
    return new Response("Stripe 渠道未启用", { status: 400 });
  }

  const order = await getOrder(context, id);
  if (!order || order.payMethod !== "stripe") {
    return new Response("订单不存在", { status: 404 });
  }
  if (order.status !== "awaiting_payment") {
    // 已付款/已过期等状态不再发起新会话，直接回订单页看状态。
    return Response.redirect(new URL(`/orders/${id}`, _request.url), 303);
  }
  if (order.payWindowEndsAt && new Date(order.payWindowEndsAt) < new Date()) {
    return Response.redirect(new URL(`/orders/${id}`, _request.url), 303);
  }

  const base = context.config.store.baseUrl.replace(/\/$/, "");
  // Stripe 会话有效期下限 30 分钟；与订单支付窗口保持一致。
  const windowMs = order.payWindowEndsAt
    ? new Date(order.payWindowEndsAt).getTime() - Date.now()
    : 30 * 60_000;
  const expiresAt = Math.floor(
    (Date.now() + Math.max(30 * 60_000, Math.min(windowMs, 24 * 3_600_000))) / 1000,
  );

  const session = await createCheckoutSession({
    secretKey,
    orderId: order.id,
    amount: order.payAmount ?? order.priceTotal ?? "0",
    currency: stripeConfig.currency,
    productName: order.productName,
    quantity: order.quantity,
    customerEmail: order.contactEmail,
    successUrl: `${base}/orders/${order.id}?stripe=return`,
    cancelUrl: `${base}/orders/${order.id}?stripe=cancel`,
    expiresAt,
  });

  if (!session.ok) {
    console.error(`[stripe] 会话创建失败 ${order.id}: ${session.error}`);
    return Response.redirect(new URL(`/orders/${id}?stripe=error`, _request.url), 303);
  }

  return Response.redirect(session.session.url, 303);
}
