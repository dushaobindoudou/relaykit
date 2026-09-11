/**
 * 触发商品目录同步。
 *
 * 由 Cron 定时调用，也可人工调用。带 ADMIN_TOKEN 保护 —— 它会打上游的
 * 接口，裸奔会被人当成免费的压测入口。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildContext, type Bindings } from "@/runtime/context";
import { syncAll } from "@/catalog/sync";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const bindings: Bindings = env;

  const expected = bindings.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") {
    return Response.json(
      { ok: false, error: "未设置 ADMIN_TOKEN，拒绝执行。请先 `wrangler secret put ADMIN_TOKEN`。" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = buildContext(bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: result.error }, { status: 503 });
  }

  const reports = await syncAll(result.context);
  return Response.json({ ok: reports.every((r) => !r.error), reports });
}
