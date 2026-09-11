import type { Metadata } from "next";

import { Shell } from "@/components/shell";
import { LookupForm } from "@/components/lookup-form";
import { getI18n } from "@/i18n";
import { getStoreMeta } from "@/runtime/store-meta";

export const metadata: Metadata = {
  title: "Find my order",
  robots: { index: false, follow: false },
};

export default async function LookupPage() {
  const store = await getStoreMeta();
  const { locale, t } = await getI18n(store.locale);

  return (
    <Shell
      storeName={store.name}
      currency={store.currency}
      categories={[]}
      locale={locale}
      t={t}
      withSidebar={false}
    >
      <div className="mx-auto max-w-sm">
        <h1 className="text-[24px] font-semibold tracking-[-0.015em]">{t.lookup.title}</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">
          {t.lookup.intro}
        </p>
        <div className="mt-7">
          <LookupForm labels={t.lookup} />
        </div>
      </div>
    </Shell>
  );
}
