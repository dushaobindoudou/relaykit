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

import { findProduct, fxFromConfig, getCatalogEntry } from "@/catalog/sync";
import { sanitizeDescription } from "@/catalog/sanitize";
import { isPlaceholderAddress } from "@/config/schema";
import { loadManualOverrides, resolveManualConfig } from "@/payments/manual-channels";
import { manualUnitPrice } from "@/pricing/engine";
import { BuyForm } from "@/components/buy-form";
import { StoreHeader } from "@/components/storefront";
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

  const { context, locale, t, user, banner , popups } = loaded.page;
  const entry = await getCatalogEntry(context, supplier, decodeURIComponent(code));
  if (!entry) notFound();

  const { config } = context;
  const currency = config.store.currency;

  const payableChains = config.payments.chains.filter(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );

  // 手动收款渠道（支付宝/微信转账）：单价按成本口径重算（如 30%），
  // 与 createOrder 的算法同源 —— 页面展示价必须等于下单结算价。
  const manualConfig = resolveManualConfig(config, await loadManualOverrides(context.db));
  const manualChannels = manualConfig?.channels.map((channel) => ({
    id: channel.id,
    label: channel.label,
  })) ?? null;
  const variantsWithManual = manualConfig
    ? await Promise.all(
        entry.variants.map(async (variant) => {
          const product = await findProduct(context, entry.supplierId, entry.code, variant.race);
          if (!product || product.price === null) return variant;
          try {
            return {
              ...variant,
              manualPrice: manualUnitPrice({
                cost: product.cost,
                baseRetailPrice: product.price,
                tierUnitPrice: variant.price,
                rates: (await fxFromConfig(context)).rates,
                fromCurrency:
                  config.suppliers.find((item) => item.id === entry.supplierId)?.currency ?? "CNY",
                toCurrency: config.store.currency,
                markupPercent: manualConfig.markupPercent,
                rounding: config.pricing.rounding,
              }),
            };
          } catch {
            // 汇率缺失等定价异常时不上手动价 —— 该渠道自然不可选，不能展示一个会亏的价。
            return variant;
          }
        }),
      )
    : entry.variants;
  const manualNote = manualConfig
    ? t.buy.manualNote(manualConfig.markupPercent.replace(/\.0+$/, "").replace(/\.$/, ""))
    : null;

  const soldOut = entry.totalStock <= 0;
  const reservableHere = soldOut && entry.reservable;
  /** 销量千分位：1 位数与 8 位数的可读性差在有没有逗号上。 */
  const salesLabel = entry.salesCount !== null ? entry.salesCount.toLocaleString("en-US") : null;

  // 富文本进页面前先清洗：结构保留、表现剥光（内联样式/font 标签），
  // 脚本与危险协议一律丢弃。视觉由 .rte 主题接管 —— 上游的碎片样式
  // 直接进来会把 Dawn 的排版打得稀碎。
  // 富文本优先（后台抓取的上游详情），退回 API 的纯文本摘要。
  // 两者都过 sanitizeDescription 白名单：结构保留、脚本与危险协议丢弃。
  const richSource = (entry.descriptionHtml ?? entry.description ?? "").trim();
  const cleanDescription = richSource ? sanitizeDescription(entry.descriptionHtml ?? entry.description ?? "") : null;

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
      availability: soldOut
        ? (entry.reservable
            ? "https://schema.org/PreOrder"
            : "https://schema.org/OutOfStock")
        : "https://schema.org/InStock",
      url: `${config.store.baseUrl}/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`,
    })),
  };

  return (
    <>
      <StoreHeader
        storeName={config.store.name}
        locale={locale}
        t={t}
        user={userSummary(user)}
        supportUrl={config.store.supportUrl ?? null}
        popups={popups}
      />

      <script
        type="application/ld+json"
        // 内容全部来自我们自己的数据库，且经过 JSON.stringify 转义。
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Tokyo 商品页骨架：左封面卡、右标题/徽章/表单 —— 与源站 1:1。 */}
      <main className="tokyo-main tokyo-page">
        <section className="tokyo-shell">
          <section className="panel tokyo-item-panel">
            <div className="panel-body">
              <div className="row g-4 align-items-stretch">
                <div className="col-12 col-lg-6 d-flex">
                  <div className="tokyo-item-cover-card w-100">
                    {entry.cover ? (
                      // 源站用外链原图；放大查看直接开新标签，省一个 lightbox。
                      <a href={entry.cover} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={entry.cover} alt={entry.name} className="item-cover" />
                        <span className="tokyo-item-cover-hint">
                          <i className="fa-duotone fa-regular fa-expand" aria-hidden />
                          <span>{t.product.viewOriginal}</span>
                        </span>
                      </a>
                    ) : (
                      <div className="item-cover d-flex align-items-center justify-content-center">
                        <span className="text-[64px] font-semibold text-[#d9d9e0]">
                          {entry.name.slice(0, 1).toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="col-12 col-lg-6 d-flex">
                  <div className="w-100 tokyo-item-form-wrap">
                    <h1 className="tokyo-item-inline-title">{entry.name}</h1>
                    <div className="tokyo-item-badges">
                      <span
                        className={`badge-soft ${
                          entry.deliveryWay === "auto" ? "badge-soft-success" : "badge-soft-warning"
                        }`}
                      >
                        {entry.deliveryWay === "auto"
                          ? t.product.autoDelivery
                          : t.product.manualDelivery}
                      </span>
                      <span className="badge-soft badge-soft-success item-stock">
                        {soldOut
                          ? reservableHere
                            ? t.product.reservable
                            : t.product.outOfStock
                          : (entry.stockText ?? t.product.inStock)}
                      </span>
                      {entry.tags.map((tag) => (
                        <span key={tag} className="badge-soft badge-soft-tag">
                          {tag}
                        </span>
                      ))}
                    </div>

                    {reservableHere && (
                      <p className="tokyo-field-hint" style={{ margin: "8px 0 12px" }}>
                        {t.product.reservableNote}
                      </p>
                    )}

                    <BuyForm
                      supplierId={entry.supplierId}
                      code={entry.code}
                      currency={currency}
                      variants={variantsWithManual}
                      chains={payableChains.map((chain) => ({ id: chain.id }))}
                      manual={manualChannels ? { channels: manualChannels, note: manualNote ?? "" } : null}
                      balance={user ? user.balance : null}
                      reservable={reservableHere}
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
                        reserveSubmit: t.buy.reserveSubmit,
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
                        chainPay: t.buy.chainPay,
                        noticeTitle: t.buy.noticeTitle,
                        noticeBody: t.buy.noticeBody,
                        noticeBodyPay: t.buy.noticeBodyPay,
                        noticeAgree: t.buy.noticeAgree,
                        noticeConfirm: t.buy.noticeConfirm,
                        noticeCancel: t.buy.noticeCancel,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {cleanDescription && (
            <section className="panel tokyo-description-panel">
              <div className="panel-header">
                <h2 className="panel-title">{t.product.details}</h2>
              </div>
              <div className="panel-body tokyo-description-body">
                {/* 上游富文本已经过 sanitizeDescription 白名单清洗：
                    结构保留、表现剥光、脚本/iframe/危险协议整体丢弃。 */}
                <div className="rte" dangerouslySetInnerHTML={{ __html: cleanDescription }} />
              </div>
            </section>
          )}
        </section>
      </main>
    </>
  );
}
