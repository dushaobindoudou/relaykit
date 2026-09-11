/** 充值单状态轮询。只返回自己的单。 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { resolveSession, SESSION_COOKIE } from "@/accounts/auth";
import { getTopup } from "@/accounts/topup";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }

  const user = await resolveSession(
    result.context,
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const topup = await getTopup(result.context, id);
  if (!topup || topup.userId !== user.id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({ status: topup.status });
}
