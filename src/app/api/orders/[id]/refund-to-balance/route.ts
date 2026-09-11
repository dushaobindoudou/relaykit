/**
 * 预订单自助退款到余额。
 *
 * 只有 reserved 状态、登录、且是本人订单才放行 —— 余额是记在账号上的钱，
 * 退给谁必须唯一确定。匿名链上付款的预订退款走客服人工，
 * 那是唯一能证明「打款地址就是付款人」的方式。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { resolveSession, SESSION_COOKIE } from "@/accounts/auth";
import { refundReservationToBalance } from "@/orders/service";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  const user = await resolveSession(
    result.context,
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  if (!user) {
    return Response.json({ ok: false, error: "请先登录再退款" }, { status: 401 });
  }

  const refunded = await refundReservationToBalance(result.context, id, user);
  if (!refunded.ok) {
    return Response.json({ ok: false, error: refunded.error }, { status: 400 });
  }

  return Response.json({ ok: true });
}
