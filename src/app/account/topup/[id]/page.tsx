import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getTopup } from "@/accounts/topup";
import { PageFrame } from "@/components/page-frame";
import { PaymentInstructions } from "@/components/payment-instructions";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Top up", robots: { index: false } };

export default async function TopupDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) redirect("/");

  const { context, locale, t, user, banner } = loaded.page;
  if (!user) redirect("/account/login");

  const topup = await getTopup(context, id);
  // 只能看自己的充值单。
  if (!topup || topup.userId !== user.id) notFound();

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
      <p className="numeric text-[13px] text-[var(--text-faint)]">{topup.id}</p>
      <h1 className="mt-2 text-[22px] font-semibold tracking-[-0.015em]">
        {t.account.topUp} {topup.amount} {context.config.store.currency}
      </h1>

      {topup.status === "awaiting_payment" ? (
        <div className="mt-6">
          <PaymentInstructions
            amount={topup.payAmount}
            address={topup.payAddress}
            chainId={topup.chainId}
            currency={context.config.store.currency}
            endsAt={topup.payWindowEndsAt}
            copy={{
              sendExactly: t.order.sendExactly,
              left: t.order.left,
              address: t.order.address,
              amount: t.order.amount,
              copy: t.order.copy,
              copied: t.order.copied,
              exactDecimals: t.order.exactDecimals,
            }}
            pollUrl={`/api/topups/${topup.id}`}
            settledRedirect="/account"
          />
        </div>
      ) : (
        <p className="mt-6 rounded-[var(--radius-card)] bg-[var(--bg-sunken)] px-4 py-3 text-[14px]">
          {topup.status === "credited" ? t.status.fulfilled.help : t.status.expired.help}
        </p>
      )}
    </PageFrame>
  );
}
