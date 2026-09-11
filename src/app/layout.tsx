import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { SiteHeader } from "@/components/site-chrome";
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
      <body className="min-h-[100dvh] antialiased">
        <SiteHeader storeName={store.name} currency={store.currency} />
        {children}
      </body>
    </html>
  );
}
