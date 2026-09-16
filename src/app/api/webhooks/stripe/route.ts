/**
 * Stripe webhook：到账确认的权威入口。
 *
 * POST /api/webhooks/stripe
 *   - 原始请求体验签（STRIPE_WEBHOOK_SECRET，5 分钟重放窗口）；
 *   - 只处理 checkout.session.completed 且 payment_status=paid；
 *   - markPaid 的事件机幂等：重复推送、乱序推送最多生效一次；
 *   - 之后与链上到账走同一条自动采购/发货管线。
 *
 * 端点在 Stripe 后台注册：事件勾选 checkout.session.completed 即可。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "drizzle-orm";

import { orders } from "@/db/schema";
import { markPaid } from "@/orders/service";
import { parseCheckoutCompleted, verifyStripeSignature } from "@/payments/stripe";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // 未配置验签密钥时直接拒绝 —— 宁可漏单重推也不能让伪造请求发货。
    return new Response("webhook not configured", { status: 503 });
  }

  const payload = await request.text();
  const verification = await verifyStripeSignature(
    payload,
    request.headers.get("stripe-signature"),
    secret,
  );
  if (!verification.ok) {
    return new Response(`signature verification failed: ${verification.reason}`, {
      status: 400,
    });
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const completed = parseCheckoutCompleted(event as Record<string, never>);
  if (!completed) {
    // 其他事件类型显式确认，避免 Stripe 无谓重试。
    return Response.json({ received: true, ignored: true });
  }
  if (completed.paymentStatus !== "paid") {
    // payment_status=unpaid 的 completed（异步手段延迟结算）不发货，等后续事件。
    return Response.json({ received: true, ignored: "not paid yet" });
  }

  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    // 配置坏了解析不了上下文：返回 500 让 Stripe 稍后重试。
    return new Response("config error", { status: 500 });
  }
  const context = result.context;

  const rows = await context.db
    .select()
    .from(orders)
    .where(eq(orders.id, completed.orderId))
    .limit(1);
  const order = rows[0];
  if (!order) {
    // 未知订单号：400 让 Stripe 停止重试（数据异常需要人工介入）。
    return new Response("unknown order", { status: 400 });
  }

  const outcome = await markPaid(context, order, completed.sessionId, order.priceTotal);
  if (!outcome.ok) {
    // 状态机拒绝（比如已过期）—— 200 应答停止重试，人工走退款/对账。
    console.error(`[stripe] webhook markPaid 拒绝 ${completed.orderId}: ${outcome.status}`);
    return Response.json({ received: true, applied: false, status: outcome.status });
  }

  console.log(`[stripe] 订单 ${completed.orderId} 已付款（session ${completed.sessionId}）`);
  return Response.json({ received: true, applied: true });
}
