/**
 * 管理端订单接口 —— manual 履约模式的闭环。
 *
 * 没有它，人工发货的店主只能直接改数据库。三个动作：
 *   GET                     列待办（paid/reserved/needs_review/procurement_failed）
 *   POST ?action=fulfill    人工发货：录入手动买到的卡密
 *   POST ?action=refund     给已付款但发不了货的订单退到客户余额
 *
 * ADMIN_TOKEN 保护；管理操作一律记事件日志（applyEvent 内置）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { listOrders, manualFulfill, getOrder, applyAdminRefund } from "@/orders/service";
import { buildContext, type Bindings } from "@/runtime/context";
import type { OrderStatus } from "@/orders/state";

export const dynamic = "force-dynamic";

const STATUSES: OrderStatus[] = [
  "paid",
  "reserved",
  "needs_review",
  "procurement_failed",
  "awaiting_payment",
  "procuring",
  "fulfilled",
  "refunded",
  "expired",
  "draft",
];

function requireAdmin(
  bindings: Bindings,
  request: Request,
): Response | null {
  const expected = bindings.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") {
    return Response.json({ ok: false, error: "未设置 ADMIN_TOKEN" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const bindings: Bindings = env;

  const denied = requireAdmin(bindings, request);
  if (denied) return denied;

  const result = buildContext(bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: result.error }, { status: 503 });
  }

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "";
  const status = STATUSES.includes(statusParam as OrderStatus)
    ? (statusParam as OrderStatus)
    : undefined;
  const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);

  const orders = await listOrders(result.context, {
    ...(status ? { status } : {}),
    limit,
  });

  // 只回运营需要的字段 —— 口令哈希这类敏感列不离开服务端。
  return Response.json({
    ok: true,
    orders: orders.map((order) => ({
      id: order.id,
      status: order.status,
      reservation: order.reservation,
      supplierId: order.supplierId,
      productCode: order.productCode,
      race: order.race,
      productName: order.productName,
      quantity: order.quantity,
      priceTotal: order.priceTotal,
      currency: order.currency,
      payMethod: order.payMethod,
      chainId: order.chainId,
      payAmount: order.payAmount,
      paidTxHash: order.paidTxHash,
      contactEmail: order.contactEmail,
      userId: order.userId,
      reviewReason: order.reviewReason,
      secret: order.status === "fulfilled" ? order.secret : null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    })),
  });
}

interface FulfillBody {
  action?: unknown;
  orderId?: unknown;
  secret?: unknown;
  leaveMessage?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const bindings: Bindings = env;

  const denied = requireAdmin(bindings, request);
  if (denied) return denied;

  const result = buildContext(bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: result.error }, { status: 503 });
  }

  let body: FulfillBody;
  try {
    body = (await request.json()) as FulfillBody;
  } catch {
    return Response.json({ ok: false, error: "请求不是合法 JSON" }, { status: 400 });
  }

  const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  if (!orderId) return Response.json({ ok: false, error: "缺少 orderId" }, { status: 400 });

  if (body.action === "fulfill") {
    const secret = typeof body.secret === "string" ? body.secret : "";
    const leaveMessage =
      typeof body.leaveMessage === "string" && body.leaveMessage.trim() !== ""
        ? body.leaveMessage.trim()
        : undefined;

    const done = await manualFulfill(result.context, orderId, secret, leaveMessage);
    if (!done.ok) return Response.json({ ok: false, error: done.error }, { status: 400 });
    return Response.json({ ok: true });
  }

  if (body.action === "refund") {
    // 管理员退款：退到下单账号的余额。匿名订单（无 userId）只能线下退，
    // 这里明确拒绝而不是假装成功。
    const order = await getOrder(result.context, orderId);
    if (!order) return Response.json({ ok: false, error: "订单不存在" }, { status: 404 });
    if (!order.userId) {
      return Response.json(
        { ok: false, error: "匿名订单无账号余额，请线下退款后标记" },
        { status: 400 },
      );
    }

    const refunded = await applyAdminRefund(result.context, order);
    if (!refunded.ok) return Response.json({ ok: false, error: refunded.error }, { status: 400 });
    return Response.json({ ok: true });
  }

  return Response.json(
    { ok: false, error: "action 必须是 fulfill 或 refund" },
    { status: 400 },
  );
}
