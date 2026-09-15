import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";

import { isPlaceholderAddress } from "@/config/schema";
import { PageFrame } from "@/components/page-frame";
import { TopupForm } from "@/components/topup-form";
import { topups } from "@/db/schema";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Top up", robots: { index: false } };

export default async function TopupPage() {
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) redirect("/");

  const { context, locale, t, user, banner, popups } = loaded.page;
  if (!user) redirect("/account/login");

  const { config } = context;
  const chains = config.payments.chains.filter(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );

  const pending = await context.db
    .select()
    .from(topups)
    .where(eq(topups.userId, user.id))
    .orderBy(desc(topups.createdAt))
    .limit(5);

  return (
    <PageFrame
      popups={popups}
      storeName={config.store.name}
      currency={config.store.currency}
      supportEmail={config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
      width="max-w-md"
    >
      <h1 className="text-[24px] font-semibold tracking-[-0.015em]">{t.account.topUp}</h1>
      <p className="numeric mt-2 text-[13px] text-[var(--text-muted)]">
        {t.account.balance} {user.balance} {config.store.currency}
      </p>

      <div className="mt-7">
        <TopupForm
          currency={config.store.currency}
          chains={chains.map((chain) => ({ id: chain.id }))}
          labels={{
            amount: t.account.topUpAmount,
            payWith: t.buy.payWith,
            submit: t.account.topUp,
            creating: t.buy.creating,
            notConfigured: t.buy.notConfigured,
          }}
        />
      </div>

      {pending.length > 0 && (
        <section className="mt-10">
          <p className="eyebrow">{t.account.transactions}</p>
          <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {pending.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="numeric text-[13px]">{row.id}</p>
                  <p className="mt-0.5 text-[12px] text-[var(--text-faint)]">
                    {row.status === "awaiting_payment"
                      ? t.status.awaiting_payment.label
                      : row.status === "credited"
                        ? t.status.fulfilled.label
                        : t.status.expired.label}
                  </p>
                </div>
                <div className="text-right">
                  <p className="numeric text-[14px]">{row.amount}</p>
                  {row.status === "awaiting_payment" && (
                    <a
                      href={`/account/topup/${row.id}`}
                      className="text-[12px] text-[var(--pop)] underline underline-offset-4"
                    >
                      {t.order.sendExactly}
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageFrame>
  );
}
