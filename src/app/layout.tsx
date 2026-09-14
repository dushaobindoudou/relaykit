import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { SupportWidget } from "@/components/support-widget";
import { getStoreMeta } from "@/runtime/store-meta";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStoreMeta();

  return {
    // %s 模板让每个商品页自动带上店名后缀，无需逐页重复。
    title: { default: store.name, template: `%s · ${store.name}` },
    description: store.description,
    metadataBase: store.baseUrl ? new URL(store.baseUrl) : undefined,
    icons: {
      // SVG 是现代浏览器的主 favicon；apple-touch 单独给位图（iOS 不认 SVG）。
      icon: "/icon.svg",
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      type: "website",
      siteName: store.name,
      title: store.name,
      description: store.description,
      // 站点级默认分享卡（scripts/generate-brand-assets.ts 生成）。
      // 商品页会用自己的封面图覆盖它。
      images: ["/og-default.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: store.name,
      description: store.description,
      images: ["/og-default.png"],
    },
    robots: { index: true, follow: true },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await getStoreMeta();

  return (
    <html lang={store.locale} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      {/* 头部与侧栏由 Shell 负责 —— 不同页面需要的外框不同（商品页不要侧栏），
          放在 layout 里就没法按页控制。客服浮窗是全站级的，恰恰相反：
          客户在任何页面卡住时都该一键够到人。 */}
      <body className="antialiased">
        {children}
        {store.supportUrl && (
          <SupportWidget url={store.supportUrl} locale={store.locale} />
        )}
      </body>
    </html>
  );
}
