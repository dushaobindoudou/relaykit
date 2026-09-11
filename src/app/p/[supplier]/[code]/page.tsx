/**
 * 商品详情页 —— 解剖结构照搬 Shopify Dawn：媒体在左、购买框在右。
 *
 * 这是站内唯一会被搜索引擎收录并带来自然流量的页面，同时要做三件事：
 * 可分享（稳定 URL）、可索引（metadata + canonical + 结构化数据）、
 * 可成交（规格与下单表单就在页面上，不跳转）。
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { getCatalogEntry } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { BuyForm } from "@/components/buy-form";
import {
  AnnouncementBar,
  StoreFooter,
  StoreHeader,
} from "@/components/storefront";
import { buildContext, type Bindings } from "@/runtime/context";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ supplier: string; code: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { supplier, code } = await params;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return { title: "Not found", robots: { index: false, follow: false } };
  }

  const entry = await getCatalogEntry(result.context, supplier, decodeURIComponent(code));
  if (!entry) return { title: "Not found", robots: { index: false, follow: false } };

  const currency = result.context.config.store.currency;
  const path = `/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`;
  const description = `${entry.name} from ${entry.fromPrice} ${currency}. Instant automatic delivery, paid in ${currency}.`;

  return {
    title: entry.name,
    description,
    // canonical 必须显式给：商品链接会被带各种参数分享出去，
    // 没有 canonical 会被当成多个重复页面，稀释权重。
    alternates: { canonical: path },
    openGraph: {
      title: entry.name,
      description,
      type: "website",
      url: path,
      ...(entry.cover ? { images: [entry.cover] } : {}),
    },
    twitter: {
      card: entry.cover ? "summary_large_image" : "summary",
      title: entry.name,
      description,
      ...(entry.cover ? { images: [entry.cover] } : {}),
    },
  };
}

export default async function ProductPage({ params }: Params) {
  const { supplier, code } = await params;
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) notFound();

  const { context, locale, t, user, banner } = loaded.page;
  const entry = await getCatalogEntry(context, supplier, decodeURIComponent(code));
  if (!entry) notFound();

  const { config } = context;
  const currency = config.store.currency;

  const payableChains = config.payments.chains.filter(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );

  // Product + Offer 结构化数据。Google 用它在搜索结果里直接显示价格与库存，
  // 对点击率的影响远大于页面上任何视觉设计。
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: entry.name,
    description: `${entry.name}. Delivered automatically after payment.`,
    sku: `${entry.supplierId}-${entry.code}`,
    ...(entry.cover ? { image: entry.cover } : {}),
    offers: entry.variants.map((variant) => ({
      "@type": "Offer",
      name: variant.race || undefined,
      price: variant.price,
      priceCurrency: currency,
      availability:
        variant.stock > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
      url: `${config.store.baseUrl}/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`,
    })),
  };

  return (
    <>
      {banner?.bannerText && <AnnouncementBar text={banner.bannerText} />}
      <StoreHeader
        storeName={config.store.name}
        locale={locale}
        t={t}
        user={userSummary(user)}
        showSearch={false}
      />

      <script
        type="application/ld+json"
        // 内容全部来自我们自己的数据库，且经过 JSON.stringify 转义。
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <nav className="text-[13px] text-[var(--text-faint)]">
          <Link href="/" className="hover:text-[var(--text)]">
            {t.product.backToAll}
          </Link>
        </nav>

        {/* Dawn 的商品页栅格：媒体与购买框各占一半，桌面端购买框吸顶。 */}
        <div className="mt-6 grid gap-8 lg:grid-cols-2 lg:gap-14">
          <div>
            <div className="aspect-square overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-sunken)]">
              {entry.cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={entry.cover}
                  alt={entry.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <span className="text-[64px] font-semibold text-[var(--line-strong)]">
                    {entry.name.slice(0, 1).toUpperCase()}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="lg:sticky lg:top-24 lg:self-start">
            <h1 className="text-[26px] font-semibold leading-[1.2] tracking-[-0.015em] sm:text-[30px]">
              {entry.name}
            </h1>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
              <span
                className={
                  entry.deliveryWay === "auto"
                    ? "rounded-full bg-[var(--pop-wash)] px-2.5 py-1 font-medium text-[var(--pop)]"
                    : "rounded-full bg-[var(--warn-wash)] px-2.5 py-1 font-medium text-[var(--warn)]"
                }
              >
                {entry.deliveryWay === "auto"
                  ? t.product.autoDelivery
                  : t.product.manualDelivery}
              </span>
              <span className="rounded-full bg-[var(--bg-sunken)] px-2.5 py-1 text-[var(--text-muted)]">
                {entry.totalStock > 0
                  ? (entry.stockText ?? t.product.inStock)
                  : t.product.outOfStock}
              </span>
              {entry.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-[var(--bg-sunken)] px-2.5 py-1 text-[var(--text-muted)]"
                >
                  {tag}
                </span>
              ))}
            </div>

            {entry.deliveryWay === "manual" && (
              <p className="mt-4 rounded-[var(--radius-card)] bg-[var(--warn-wash)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--warn)]">
                {t.product.manualNote}
              </p>
            )}

            <div className="mt-6">
              <BuyForm
                supplierId={entry.supplierId}
                code={entry.code}
                currency={currency}
                variants={entry.variants}
                chains={payableChains.map((chain) => ({ id: chain.id }))}
                balance={user ? user.balance : null}
                labels={{
                  option: t.buy.option,
                  standard: t.buy.standard,
                  quantity: t.buy.quantity,
                  email: t.buy.email,
                  emailHint: t.buy.emailHint,
                  password: t.buy.password,
                  passwordHint: t.buy.passwordHint,
                  payWith: t.buy.payWith,
                  total: t.buy.total,
                  submit: t.buy.submit,
                  creating: t.buy.creating,
                  soldOut: t.buy.soldOut,
                  notConfigured: t.buy.notConfigured,
                  // 函数型文案必须在服务端求值 —— 函数不能跨 RSC 边界序列化。
                  window: t.buy.window(config.payments.windowMinutes),
                  couponLabel: t.coupon.label,
                  couponApply: t.coupon.apply,
                  couponRemove: t.coupon.remove,
                  subtotal: t.coupon.subtotal,
                  discount: t.coupon.discount,
                  payWithBalance: t.account.payWithBalance,
                  insufficient: t.account.insufficient,
                  balanceLabel: t.account.balance,
                }}
              />
            </div>

            <section className="mt-8 border-t border-[var(--line)] pt-6">
              <p className="eyebrow">{t.product.howItWorks}</p>
              <ol className="mt-3 grid gap-2.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
                <li className="flex gap-2.5">
                  <span className="numeric text-[var(--pop)]">1</span>
                  {t.product.step1}
                </li>
                <li className="flex gap-2.5">
                  <span className="numeric text-[var(--pop)]">2</span>
                  {t.product.step2}
                </li>
                <li className="flex gap-2.5">
                  <span className="numeric text-[var(--pop)]">3</span>
                  {t.product.step3}
                </li>
              </ol>
              <p className="mt-4 text-[12px] leading-relaxed text-[var(--text-faint)]">
                {t.product.exactAmountNote}
              </p>
            </section>
          </div>
        </div>

        {entry.description && (
          <section className="mt-14 border-t border-[var(--line)] pt-8">
            <p className="eyebrow">{t.product.details}</p>
            {/* 上游商品详情是富文本。它来自我们自己对接的供货商后台，
                不是终端用户输入；若将来对接不受信任的上游，这里必须加白名单过滤。 */}
            <div
              className="rte mt-3 max-w-3xl text-[14px] text-[var(--text-muted)]"
              dangerouslySetInnerHTML={{ __html: entry.description }}
            />
          </section>
        )}
      </main>

      <StoreFooter
        storeName={config.store.name}
        currency={currency}
        supportEmail={config.store.supportEmail ?? null}
        t={t}
      />
    </>
  );
}
