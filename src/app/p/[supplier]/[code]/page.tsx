/**
 * 商品详情页。
 *
 * 这是整个站里**唯一会被搜索引擎收录并带来自然流量的页面**，所以它同时要做三件事：
 *   1. 可分享 —— 一个稳定 URL 发给任何人，对方能自己看懂并下单
 *   2. 可索引 —— 完整 metadata、canonical、Product/Offer 结构化数据
 *   3. 可成交 —— 规格选择与下单表单就在页面上，不跳转
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { getCatalogEntry } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { Badge } from "@/components/site-chrome";
import { BuyForm } from "@/components/buy-form";
import { Shell } from "@/components/shell";
import { listCategories } from "@/catalog/sync";
import { getI18n } from "@/i18n";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ supplier: string; code: string }>;
}

async function load(params: Params["params"]) {
  const { supplier, code } = await params;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) return null;

  const entry = await getCatalogEntry(
    result.context,
    supplier,
    decodeURIComponent(code),
  );
  return entry ? { context: result.context, entry } : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const loaded = await load(params);
  if (!loaded) return { title: "Not found", robots: { index: false, follow: false } };

  const { context, entry } = loaded;
  const currency = context.config.store.currency;
  const path = `/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`;
  const description = `${entry.name} from ${entry.fromPrice} ${currency}. Instant automatic delivery, paid in ${currency}.`;

  return {
    title: entry.name,
    description,
    // canonical 必须显式给：同一商品可能被带各种查询参数分享出去，
    // 没有 canonical 会被当成多个重复页面，稀释权重。
    alternates: { canonical: path },
    openGraph: { title: entry.name, description, type: "website", url: path },
    twitter: { card: "summary_large_image", title: entry.name, description },
  };
}

export default async function ProductPage({ params }: Params) {
  const loaded = await load(params);
  if (!loaded) notFound();

  const { context, entry } = loaded;
  const { config } = context;
  const currency = config.store.currency;

  const payableChains = config.payments.chains.filter(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );

  // Product + Offer 结构化数据。Google 用它在搜索结果里直接显示价格与库存，
  // 对转化率的影响远大于页面上任何视觉设计。
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: entry.name,
    description: `${entry.name}. Delivered automatically after payment.`,
    sku: `${entry.supplierId}-${entry.code}`,
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

  const { locale, t } = await getI18n(config.store.locale);
  const categories = await listCategories(context);

  return (
    <Shell
      storeName={config.store.name}
      currency={currency}
      categories={categories}
      activeCategoryId={entry.categoryId ?? undefined}
      locale={locale}
      t={t}
      withSidebar={false}
    >
      <script
        type="application/ld+json"
        // 内容全部来自我们自己的数据库，且经过 JSON.stringify 转义。
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <nav className="text-[13px] text-[var(--text-faint)]">
        <Link href="/" className="hover:text-[var(--text)]">
          {t.product.backToAll}
        </Link>
      </nav>

      <div className="mt-5 grid gap-10 lg:grid-cols-[1fr_360px] lg:gap-12">
        <div className="min-w-0">
          <div className="flex items-start gap-4">
            {entry.cover && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={entry.cover}
                alt=""
                className="h-16 w-16 shrink-0 rounded-[var(--radius-card)] object-cover"
              />
            )}
            <h1 className="text-[24px] font-semibold leading-[1.25] tracking-[-0.015em] sm:text-[28px]">
              {entry.name}
            </h1>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge tone={entry.deliveryWay === "auto" ? "ok" : "warn"}>
              {entry.deliveryWay === "auto"
                ? t.product.autoDelivery
                : t.product.manualDelivery}
            </Badge>
            <Badge tone={entry.totalStock > 0 ? "neutral" : "warn"}>
              {entry.totalStock > 0
                ? (entry.stockText ?? t.product.inStock)
                : t.product.outOfStock}
            </Badge>
            {entry.tags.map((tag) => (
              <Badge key={tag} tone="accent">
                {tag}
              </Badge>
            ))}
          </div>

          {entry.deliveryWay === "manual" && (
            <p className="mt-4 rounded-[var(--radius-card)] bg-[var(--warn-wash)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--warn)]">
              {t.product.manualNote}
            </p>
          )}

          {entry.description && (
            <section className="mt-8 border-t border-[var(--line)] pt-6">
              <h2 className="text-[13px] font-semibold text-[var(--text-faint)]">
                {t.product.details}
              </h2>
              {/* 上游商品详情是富文本。它来自我们自己对接的供货商后台，
                  不是用户输入，但仍然是外部内容 —— 若将来对接不受信任的上游，
                  这里必须加白名单过滤。 */}
              <div
                className="prose-sm mt-3 text-[14px] leading-relaxed text-[var(--text-muted)] [&_a]:text-[var(--accent)] [&_img]:max-w-full"
                dangerouslySetInnerHTML={{ __html: entry.description }}
              />
            </section>
          )}

          <section className="mt-8 border-t border-[var(--line)] pt-6">
            <h2 className="text-[13px] font-semibold text-[var(--text-faint)]">
              {t.product.howItWorks}
            </h2>
            <ol className="mt-3 grid gap-3 text-[14px] leading-relaxed text-[var(--text-muted)] sm:grid-cols-3">
              <li>
                <span className="numeric mr-2 text-[var(--accent)]">1</span>
                {t.product.step1}
              </li>
              <li>
                <span className="numeric mr-2 text-[var(--accent)]">2</span>
                {t.product.step2}
              </li>
              <li>
                <span className="numeric mr-2 text-[var(--accent)]">3</span>
                {t.product.step3}
              </li>
            </ol>
            <p className="mt-4 max-w-prose text-[13px] leading-relaxed text-[var(--text-faint)]">
              {t.product.exactAmountNote}
            </p>
          </section>
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <BuyForm
            supplierId={entry.supplierId}
            code={entry.code}
            currency={currency}
            variants={entry.variants}
            chains={payableChains.map((chain) => ({
              id: chain.id,
              confirmations: chain.confirmations,
            }))}
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
            }}
          />
        </div>
      </div>
    </Shell>
  );
}
