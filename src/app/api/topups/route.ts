import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { resolveSession, SESSION_COOKIE } from "@/accounts/auth";
import { createTopup } from "@/accounts/topup";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  const user = await resolveSession(
    result.context,
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  if (!user) return Response.json({ ok: false, error: "请先登录" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = await createTopup(
    result.context,
    user,
    String(body.amount ?? ""),
    String(body.chainId ?? ""),
  );

  if (!created.ok) return Response.json(created, { status: 400 });
  return Response.json({ ok: true, topupId: created.topup.id });
}
