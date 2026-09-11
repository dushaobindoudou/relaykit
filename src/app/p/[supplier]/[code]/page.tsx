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
import { Badge, Page, SiteFooter } from "@/components/site-chrome";
import { BuyForm } from "@/components/buy-form";
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

  return (
    <>
      <script
        type="application/ld+json"
        // 内容全部来自我们自己的数据库，且经过 JSON.stringify 转义。
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Page>
        <nav className="text-[13px] text-[var(--text-faint)]">
          <Link href="/" className="hover:text-[var(--text)]">
            All products
          </Link>
        </nav>

        <div className="mt-6 grid gap-12 lg:grid-cols-[1fr_380px] lg:gap-16">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] sm:text-[34px]">
              {entry.name}
            </h1>

            <div className="mt-4 flex flex-wrap gap-2">
              <Badge tone="ok">Instant delivery</Badge>
              {entry.totalStock > 0 ? (
                <Badge>In stock</Badge>
              ) : (
                <Badge tone="warn">Out of stock</Badge>
              )}
            </div>

            <div className="mt-10 border-t border-[var(--line)] pt-8">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
                How it works
              </h2>
              <ol className="mt-4 grid gap-4 text-[14px] leading-relaxed text-[var(--text-muted)] sm:grid-cols-3">
                <li>
                  <span className="numeric mr-2 text-[var(--accent)]">1</span>
                  Pick an option and enter your email.
                </li>
                <li>
                  <span className="numeric mr-2 text-[var(--accent)]">2</span>
                  Send the exact amount to the address shown.
                </li>
                <li>
                  <span className="numeric mr-2 text-[var(--accent)]">3</span>
                  Your code appears on the order page.
                </li>
              </ol>
              <p className="mt-5 max-w-prose text-[13px] leading-relaxed text-[var(--text-faint)]">
                Send the exact amount shown at checkout. The trailing decimals identify
                your order, so a rounded amount cannot be matched automatically.
              </p>
            </div>
          </div>

          {/* 下单区。lg 以上吸顶，长页面滚动时购买入口始终可见。 */}
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
              windowMinutes={config.payments.windowMinutes}
            />
          </div>
        </div>
      </Page>
      <SiteFooter supportEmail={config.store.supportEmail ?? null} />
    </>
  );
}
