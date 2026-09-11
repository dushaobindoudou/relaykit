/**
 * 账户中心：余额、我的订单、余额明细。
 *
 * 原站登录后的核心页面。订单列表直接给出卡密入口 —— 复购客户回来的
 * 第一件事往往是「我上次买的那个码呢」。
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";

import { listTransactions } from "@/accounts/balance";
import { PageFrame } from "@/components/page-frame";
import { SignOutButton } from "@/components/sign-out";
import { orders } from "@/db/schema";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account", robots: { index: false } };

const STATUS_TONE: Record<string, string> = {
  fulfilled: "text-[var(--pop)]",
  awaiting_payment: "text-[var(--text-muted)]",
  paid: "text-[var(--text-muted)]",
  procuring: "text-[var(--text-muted)]",
  needs_review: "text-[var(--warn)]",
  procurement_failed: "text-[var(--danger)]",
  refunded: "text-[var(--text-faint)]",
  expired: "text-[var(--text-faint)]",
};

export default async function AccountPage() {
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) redirect("/");

  const { context, locale, t, user, banner } = loaded.page;
  if (!user) redirect("/account/login");

  const [myOrders, transactions] = await Promise.all([
    context.db
      .select()
      .from(orders)
      .where(eq(orders.userId, user.id))
      .orderBy(desc(orders.createdAt))
      .limit(30),
    listTransactions(context, user.id, 20),
  ]);

  const currency = context.config.store.currency;

  return (
    <PageFrame
      storeName={context.config.store.name}
      currency={currency}
      supportEmail={context.config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.015em]">
            {t.account.dashboard}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--text-muted)]">{user.email}</p>
        </div>
        <SignOutButton label={t.account.signOut} />
      </div>

      {/* 余额卡：这是登录后最被关注的数字，给它整页最大的字号。 */}
      <section className="mt-8 rounded-[var(--radius-card)] bg-[var(--bg-sunken)] p-6">
        <p className="eyebrow">{t.account.balance}</p>
        <p className="numeric mt-2 text-[36px] font-semibold leading-none">
          {user.balance}
          <span className="ml-2 font-sans text-[14px] font-normal text-[var(--text-muted)]">
            {currency}
          </span>
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            href="/account/topup"
            className="inline-flex h-11 items-center rounded-[var(--radius-card)] bg-[var(--accent)] px-5 text-[14px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
          >
            {t.account.topUp}
          </Link>
          <span className="numeric text-[13px] text-[var(--text-faint)]">
            {t.account.totalSpent} {user.totalSpent} {currency}
          </span>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-[15px] font-semibold">{t.account.myOrders}</h2>
        {myOrders.length === 0 ? (
          <p className="mt-3 text-[13px] text-[var(--text-muted)]">{t.account.noOrders}</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {myOrders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/orders/${order.id}`}
                  className="flex items-center justify-between gap-4 py-3.5 hover:bg-[var(--bg-sunken)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[14px]">{order.productName}</p>
                    <p className="numeric mt-0.5 text-[12px] text-[var(--text-faint)]">
                      {order.id} · {order.createdAt.slice(0, 10)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="numeric text-[14px]">{order.priceTotal}</p>
                    <p
                      className={`mt-0.5 text-[12px] ${
                        STATUS_TONE[order.status] ?? "text-[var(--text-faint)]"
                      }`}
                    >
                      {t.status[order.status as keyof typeof t.status]?.label ?? order.status}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-[15px] font-semibold">{t.account.transactions}</h2>
        {transactions.length === 0 ? (
          <p className="mt-3 text-[13px] text-[var(--text-muted)]">
            {t.account.noTransactions}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {transactions.map((tx) => (
              <li key={tx.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-[13px]">{tx.note ?? tx.kind}</p>
                  <p className="numeric mt-0.5 text-[12px] text-[var(--text-faint)]">
                    {tx.createdAt.slice(0, 16).replace("T", " ")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {/* 带符号展示：进账与出账要一眼分得开。 */}
                  <p
                    className={`numeric text-[14px] ${
                      tx.amount.startsWith("-") ? "text-[var(--text)]" : "text-[var(--pop)]"
                    }`}
                  >
                    {tx.amount.startsWith("-") ? tx.amount : `+${tx.amount}`}
                  </p>
                  <p className="numeric mt-0.5 text-[12px] text-[var(--text-faint)]">
                    {tx.balanceAfter}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageFrame>
  );
}
