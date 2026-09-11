import { getCloudflareContext } from "@opennextjs/cloudflare";

import { login, SESSION_COOKIE } from "@/accounts/auth";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const auth = await login(
    result.context,
    String(body.email ?? ""),
    String(body.password ?? ""),
  );

  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: 401 });

  const response = Response.json({ ok: true });
  // httpOnly：JS 读不到 token，XSS 也偷不走会话。
  // sameSite=lax：跨站请求不带上它，同时不影响从外链点进来的正常导航。
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${auth.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`,
  );
  return response;
}
