import type { MetadataRoute } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { listCatalog } from "@/catalog/sync";
import { buildContext, type Bindings } from "@/runtime/context";
import { getStoreMeta } from "@/runtime/store-meta";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const store = await getStoreMeta();
  if (!store.baseUrl) return [];

  const base = store.baseUrl.replace(/\/+$/, "");
  const entries: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: "daily", priority: 1 },
  ];

  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) return entries;

  // 只收录可售商品。把缺货或下架的页面留在 sitemap 里，抓取预算会被浪费在
  // 一堆返回"暂不可售"的页面上。
  for (const entry of await listCatalog(result.context)) {
    entries.push({
      url: `${base}/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`,
      changeFrequency: "daily",
      priority: 0.8,
    });
  }

  return entries;
}
