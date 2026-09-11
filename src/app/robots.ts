import type { MetadataRoute } from "next";

import { getStoreMeta } from "@/runtime/store-meta";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const store = await getStoreMeta();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // 订单页含卡密，绝不能被抓取；管理与接口路径同理。
      // /help 刻意不屏蔽 —— 它是主要的 SEO 落地内容。
      disallow: ["/orders/", "/lookup", "/account", "/api/"],
    },
    sitemap: store.baseUrl ? `${store.baseUrl}/sitemap.xml` : undefined,
  };
}
