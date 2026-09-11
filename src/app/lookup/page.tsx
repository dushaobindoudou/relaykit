import type { Metadata } from "next";

import { Page, SiteFooter } from "@/components/site-chrome";
import { LookupForm } from "@/components/lookup-form";
import { getStoreMeta } from "@/runtime/store-meta";

export const metadata: Metadata = {
  title: "Find my order",
  robots: { index: false, follow: false },
};

export default async function LookupPage() {
  const store = await getStoreMeta();

  return (
    <>
      <Page>
        <div className="mx-auto max-w-sm">
          <h1 className="text-[24px] font-semibold tracking-[-0.015em]">Find my order</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">
            Enter the order number from your confirmation page and the password you set
            when ordering.
          </p>
          <div className="mt-7">
            <LookupForm />
          </div>
        </div>
      </Page>
      <SiteFooter supportEmail={store.supportEmail} />
    </>
  );
}
