/**
 * 收款账号管理：GET/POST /api/admin/channels（ADMIN_TOKEN Bearer 保护）。
 *
 * GET  返回合并视图：channels（后台表单的编辑源，覆盖优先）+ markupPercent。
 * POST 保存整组渠道（zod 校验后写 settings 表的 manual_channels 键）。
 *      空数组 = 关闭全部人工渠道。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  loadManualOverrides,
  resolveManualConfig,
  saveManualOverrides,
  storedChannelsSchema,
} from "@/payments/manual-channels";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

/** 与其他 /api/admin/* 一致的令牌闸门。 */
function checkAuth(env: Bindings, request: Request): Response | null {
  const expected = env.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") {
    return Response.json(
      { ok: false, error: "未设置 ADMIN_TOKEN，拒绝执行。请先 `wrangler secret put ADMIN_TOKEN`。" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function getContext(): Response | { context: NonNullable<ReturnType<typeof buildContext>["context"]> } {
  const { env } = getCloudflareContext();
  const built = buildContext(env satisfies Bindings);
  if (!built.ok || !built.context) {
    return Response.json({ ok: false, error: "context unavailable" }, { status: 500 });
  }
  return { context: built.context };
}

export async function GET(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const denied = checkAuth(env satisfies Bindings, request);
  if (denied) return denied;

  const loaded = getContext();
  if (loaded instanceof Response) return loaded;
  const { config, db } = loaded.context;

  const stored = await loadManualOverrides(db);
  const merged = resolveManualConfig(config, stored);

  return Response.json({
    ok: true,
    // 生效中的渠道（关闭位/空账号已滤掉）——与结账表单实际所见一致
    active: merged?.channels ?? [],
    // 后台表单的编辑源：运营态覆盖优先，没有则回配置默认（默认全启用）
    channels:
      stored ??
      (config.payments.manual?.channels ?? []).map((item) => ({
        ...item,
        enabled: true,
      })),
    markupPercent: config.payments.manual?.markupPercent ?? "30",
  });
}

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const denied = checkAuth(env satisfies Bindings, request);
  if (denied) return denied;

  const loaded = getContext();
  if (loaded instanceof Response) return loaded;
  const { db } = loaded.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const parsed = storedChannelsSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  }

  await saveManualOverrides(db, parsed.data.channels);
  return Response.json({ ok: true, channels: parsed.data.channels });
}
