import type { MetadataRoute } from "next";

import { getStoreMeta } from "@/runtime/store-meta";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const store = await getStoreMeta();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // 订单页含卡密，绝不能被抓取；管理与接口路径同理。
      disallow: ["/orders/", "/lookup", "/api/"],
    },
    sitemap: store.baseUrl ? `${store.baseUrl}/sitemap.xml` : undefined,
  };
}
