import type { Metadata } from "next";

import { PageFrame } from "@/components/page-frame";
import { LookupForm } from "@/components/lookup-form";
import { loadPage, userSummary } from "@/runtime/page-context";

// 依赖运行时上下文（cookie 里的语言与登录态），不能预渲染。
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Find my order",
  robots: { index: false, follow: false },
};

export default async function LookupPage() {
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) return null;

  const { context, locale, t, user, banner } = loaded.page;

  return (
    <PageFrame
      storeName={context.config.store.name}
      currency={context.config.store.currency}
      supportEmail={context.config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
      width="max-w-md"
    >
      <h1 className="text-[24px] font-semibold tracking-[-0.015em]">{t.lookup.title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">
        {t.lookup.intro}
      </p>
      <div className="mt-7">
        <LookupForm labels={t.lookup} />
      </div>
    </PageFrame>
  );
}
