/** 店面商品列表（JSON）。UI 与外部集成都读它。 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildContext, type Bindings } from "@/runtime/context";
import { listSellable } from "@/catalog/sync";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: result.error }, { status: 503 });
  }

  const rows = await listSellable(result.context);
  return Response.json({
    ok: true,
    currency: result.context.config.store.currency,
    // 成本价不出站 —— 这是我们的进货价，不该出现在任何面向客户的响应里。
    items: rows.map((row) => ({
      supplierId: row.supplierId,
      code: row.code,
      race: row.race,
      name: row.name,
      price: row.price,
      stock: row.stock,
    })),
  });
}
