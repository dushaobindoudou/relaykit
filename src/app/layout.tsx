import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { getStoreMeta } from "@/runtime/store-meta";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStoreMeta();

  return {
    // %s 模板让每个商品页自动带上店名后缀，无需逐页重复。
    title: { default: store.name, template: `%s · ${store.name}` },
    description: store.description,
    metadataBase: store.baseUrl ? new URL(store.baseUrl) : undefined,
    openGraph: {
      type: "website",
      siteName: store.name,
      title: store.name,
      description: store.description,
    },
    twitter: { card: "summary_large_image", title: store.name, description: store.description },
    robots: { index: true, follow: true },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await getStoreMeta();

  return (
    <html lang={store.locale} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      {/* 头部与侧栏由 Shell 负责 —— 不同页面需要的外框不同（商品页不要侧栏），
          放在 layout 里就没法按页控制。 */}
      <body className="antialiased">{children}</body>
    </html>
  );
}
