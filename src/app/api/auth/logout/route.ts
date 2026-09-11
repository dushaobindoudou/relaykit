import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { logout, SESSION_COOKIE } from "@/accounts/auth";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (result.ok && result.context) {
    await logout(result.context, (await cookies()).get(SESSION_COOKIE)?.value);
  }

  const response = Response.json({ ok: true });
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
  return response;
}
