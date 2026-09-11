/**
 * 订单状态查询。轮询与查单都走它。
 *
 * 卡密是**凭口令**才下发的。订单号本身不足以作为凭证 —— 它会出现在 URL、
 * 浏览器历史、截图里，而卡密等同于现金。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { getOrder, verifyOrderPassword } from "@/orders/service";
import { canRevealSecret } from "@/orders/state";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }

  const order = await getOrder(result.context, id);
  if (!order) return Response.json({ error: "not_found" }, { status: 404 });

  const password = new URL(request.url).searchParams.get("k") ?? "";
  const authorized = password !== "" && (await verifyOrderPassword(order, password));

  return Response.json({
    status: order.status,
    // 双重条件：口令对，且状态确实允许展示。任何一个不满足都只回 null，
    // 不回显"口令错误"与"尚未发货"的区别 —— 那是在帮人猜口令。
    secret: authorized && canRevealSecret(order.status as never) ? order.secret : null,
    leaveMessage: authorized ? order.leaveMessage : null,
  });
}
