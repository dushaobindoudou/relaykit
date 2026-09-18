import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { SupportWidget } from "@/components/support-widget";
import { getStoreMeta } from "@/runtime/store-meta";
import "./globals.css";
import "@/styles/tokyo.css";
import "@/styles/tokyo-overrides.css";

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStoreMeta();

  return {
    // %s 模板让每个商品页自动带上店名后缀，无需逐页重复。
    title: { default: store.name, template: `%s · ${store.name}` },
    description: store.description,
    // 关键词矩阵与源站同构（同品类词），并补上我们的代充长尾。
    keywords: [
      "AI账号", "AI账号批发", "AI账号代充", "AI充值站",
      "ChatGPT Plus账号", "GPT Plus代充值", "GPT Pro会员",
      "Gemini Pro会员", "Gemini Ultra家庭组", "Claude Pro直充",
      "Grok Super会员", "Cursor Pro账号", "Kiro Pro账号",
      "CapCut Pro会员", "Kling会员", "谷歌邮箱", "Gmail老号",
      "谷歌接码", "苹果ID", "AI会员低价开通",
    ].join(","),
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
      <head>
        {/* Bootstrap（MIT）与 Font Awesome Free（OFL/CC BY）自托管：
            视觉基线与源站一致，但不依赖它的 CDN。 */}
        {/* eslint-disable-next-line @next/next/no-css-tags -- vendor 产物不能走打包导入 */}
        <link rel="stylesheet" href="/vendor/css/bootstrap.min.css" />
        {/* eslint-disable-next-line @next/next/no-css-tags -- vendor 产物不能走打包导入 */}
        <link rel="stylesheet" href="/vendor/fontawesome/all.min.css" />
        {/* Bootstrap 折叠菜单 JS：<1200px 导航汉堡开关靠它（源站同样加载） */}
        <script defer src="/vendor/js/bootstrap.bundle.min.js" />
      </head>
      {/* 头部与侧栏由 Shell 负责 —— 不同页面需要的外框不同（商品页不要侧栏），
          放在 layout 里就没法按页控制。客服浮窗是全站级的，恰恰相反：
          客户在任何页面卡住时都该一键够到人。 */}
      <body className="tokyo-theme antialiased">
        {children}
        {store.supportUrl && (
          <SupportWidget url={store.supportUrl} locale={store.locale} />
        )}
      </body>
    </html>
  );
}
