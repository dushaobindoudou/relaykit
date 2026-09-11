/**
 * 目录注入端点。
 *
 * 用于上游对 Worker 出口 IP 做了拦截的情况（见 docs/upstream-access.md）：
 * 抓取由一台能访问上游的主机上的同步脚本完成（scripts/sync-upstream.ts），
 * 把归一化后的分类与商品 POST 到这里。Worker **不自己调上游**，
 * 只对收到的数据做定价与落库 —— 定价规则因此仍集中在一处。
 *
 * 用 ADMIN_TOKEN 保护：它会写商品表并触发下架逻辑，不能裸奔。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { syncSupplier, type PrefetchedCatalog } from "@/catalog/sync";
import { resumeReservations } from "@/orders/service";
import { buildContext, type Bindings } from "@/runtime/context";
import type { SupplierCategory, SupplierProduct } from "@/supplier/types";

export const dynamic = "force-dynamic";

interface IngestBody {
  supplierId?: unknown;
  categories?: unknown;
  products?: unknown;
}

/** 归一化商品：只接受适配器约定的形状，缺字段给安全默认值。 */
function normalizeProduct(raw: unknown): SupplierProduct | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const code = typeof row.code === "string" ? row.code : String(row.code ?? "");
  if (!code) return null;

  const record = (value: unknown): Record<string, string> =>
    typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : {};

  const product: SupplierProduct = {
    code,
    name: typeof row.name === "string" ? row.name : "",
    deliveryWay: row.deliveryWay === "manual" ? "manual" : "auto",
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    races: Array.isArray(row.races) ? row.races.map(String) : [],
    costByRace: record(row.costByRace),
    listPriceByRace: record(row.listPriceByRace),
    stock: Number.isFinite(Number(row.stock)) ? Number(row.stock) : 0,
    currencyCode: typeof row.currencyCode === "string" ? row.currencyCode : "CNY",
  };

  if (typeof row.cover === "string" && row.cover) product.cover = row.cover;
  if (typeof row.categoryId === "string" && row.categoryId)
    product.categoryId = row.categoryId;
  if (typeof row.stockText === "string" && row.stockText)
    product.stockText = row.stockText;
  if (typeof row.description === "string" && row.description)
    product.description = row.description;
  {
    const sales = Number(row.salesCount);
    if (Number.isFinite(sales) && sales >= 0) product.salesCount = Math.floor(sales);
  }
  if (row.reservable === true || row.reservable === 1) product.reservable = true;

  return product;
}

function normalizeCategory(raw: unknown): SupplierCategory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : String(row.id ?? "");
  if (!id) return null;

  const category: SupplierCategory = {
    id,
    name: typeof row.name === "string" ? row.name : "",
    sort: Number.isFinite(Number(row.sort)) ? Number(row.sort) : 0,
  };
  if (typeof row.icon === "string" && row.icon) category.icon = row.icon;
  if (typeof row.parentId === "string" && row.parentId) category.parentId = row.parentId;
  return category;
}

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const bindings: Bindings = env;

  const expected = bindings.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") {
    return Response.json({ ok: false, error: "未设置 ADMIN_TOKEN" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = buildContext(bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: result.error }, { status: 503 });
  }

  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return Response.json({ ok: false, error: "请求不是合法 JSON" }, { status: 400 });
  }

  const supplierId = typeof body.supplierId === "string" ? body.supplierId : "";
  if (!result.context.config.suppliers.some((s) => s.id === supplierId)) {
    return Response.json(
      { ok: false, error: `supplierId "${supplierId}" 不在配置里` },
      { status: 400 },
    );
  }

  const products = (Array.isArray(body.products) ? body.products : [])
    .map(normalizeProduct)
    .filter((item): item is SupplierProduct => item !== null);

  const categories = (Array.isArray(body.categories) ? body.categories : [])
    .map(normalizeCategory)
    .filter((item): item is SupplierCategory => item !== null);

  // 空目录直接拒绝落库：一次抓取失败若被当成"上游清空了"，会触发全量下架，
  // 把好好的店面清空。宁可这次不更新，也不要用空数据覆盖。
  if (products.length === 0) {
    return Response.json(
      { ok: false, error: "products 为空，拒绝落库（避免误将全店下架）" },
      { status: 400 },
    );
  }

  const prefetched: PrefetchedCatalog = { products, categories };
  const report = await syncSupplier(result.context, supplierId, new Date(), prefetched);

  // 注入式同步的目录同样可能带来补货：auto 模式下顺手续履约预订单。
  const reservationsResumed = await resumeReservations(result.context);

  return Response.json({ ok: !report.error, reservationsResumed, report });
}
