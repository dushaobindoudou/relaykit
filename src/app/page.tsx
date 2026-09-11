import Link from "next/link";

import { listCatalog, type CatalogEntry } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { AnnouncementPopup } from "@/components/announcement-popup";
import {
  AnnouncementBar,
  CategoryNav,
  StoreFooter,
  StoreHeader,
} from "@/components/storefront";
import type { Dict } from "@/i18n/dictionary";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";

/**
 * 商品卡 —— Dawn 的解剖结构：方图 + 标题 + 价格，没有边框没有卡片容器。
 * 图片本身承担视觉分组，再套一层描边框会让网格显得拥挤。
 */
function ProductCard({
  entry,
  currency,
  t,
}: {
  entry: CatalogEntry;
  currency: string;
  t: Dict;
}) {
  const soldOut = entry.totalStock <= 0;

  return (
    <Link
      href={`/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`}
      className="group block"
    >
      <div className="relative aspect-square overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-sunken)]">
        {entry.cover ? (
          // 不用 next/image：Workers 上没有 sharp，且这些是外站图片。
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.cover}
            alt={entry.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-[28px] font-semibold text-[var(--line-strong)]">
              {entry.name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        )}

        {entry.deliveryWay === "auto" && (
          <span className="absolute left-2 top-2 rounded-full bg-[var(--bg)]/90 px-2 py-0.5 text-[11px] font-medium text-[var(--pop)] backdrop-blur">
            {t.product.autoDelivery}
          </span>
        )}
        {soldOut && (
          <span className="absolute inset-x-0 bottom-0 bg-[var(--accent)]/85 py-1.5 text-center text-[12px] text-[var(--accent-fg)]">
            {t.product.outOfStock}
          </span>
        )}
      </div>

      <h3 className="mt-3 line-clamp-2 text-[14px] font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
        {entry.name}
      </h3>

      <div className="mt-1.5 flex items-baseline gap-1.5">
        {entry.variants.length > 1 && (
          <span className="text-[11px] text-[var(--text-faint)]">{t.product.from}</span>
        )}
        <span className="numeric text-[15px] font-semibold text-[var(--pop)]">
          {entry.fromPrice}
        </span>
        <span className="text-[11px] text-[var(--text-faint)]">{currency}</span>
      </div>

      {entry.stockText && (
        <p className="mt-1 text-[11px] text-[var(--text-faint)]">{entry.stockText}</p>
      )}
    </Link>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; q?: string }>;
}) {
  const { c: categoryId, q: search } = await searchParams;
  const loaded = await loadPage();

  if (!loaded.ok) {
    const { t } = loaded;
    return (
      <main className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-[24px] font-semibold tracking-tight">{t.setup.title}</h1>
        <p className="mt-2 text-[14px] text-[var(--text-muted)]">{t.setup.intro}</p>
        <pre className="mt-5 overflow-x-auto rounded-[var(--radius-card)] bg-[var(--bg-sunken)] p-4 text-[13px] leading-relaxed">
          {loaded.error}
        </pre>
        <p className="mt-4 text-[13px] text-[var(--text-muted)]">
          {t.setup.diagnostics}{" "}
          <Link href="/api/health" className="text-[var(--pop)] underline underline-offset-4">
            /api/health
          </Link>
        </p>
      </main>
    );
  }

  const { context, locale, t, user, categories, banner, popups } = loaded.page;
  const { config } = context;

  const entries = await listCatalog(context, {
    ...(categoryId ? { categoryId } : {}),
    ...(search ? { search } : {}),
  });

  const unpayable = config.payments.chains
    .filter((chain) => chain.enabled && isPlaceholderAddress(chain.address))
    .map((chain) => chain.id);
  const canSell = unpayable.length < config.payments.chains.filter((c) => c.enabled).length;

  const activeCategory = categories.find((item) => item.externalId === categoryId);

  return (
    <>
      {banner?.bannerText && <AnnouncementBar text={banner.bannerText} />}
      <StoreHeader
        storeName={config.store.name}
        locale={locale}
        t={t}
        user={userSummary(user)}
        search={search}
      />
      <CategoryNav categories={categories} activeId={categoryId} t={t} />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {!canSell && (
          <div className="mb-8 rounded-[var(--radius-card)] border border-[var(--warn)]/25 bg-[var(--warn-wash)] px-4 py-3 text-[13px] leading-relaxed text-[var(--warn)]">
            <strong className="font-semibold">{t.setup.demoMode}</strong>{" "}
            {t.setup.demoBody(unpayable.join(", "))}
          </div>
        )}

        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">
            {activeCategory ? activeCategory.name : t.nav.allCategories}
          </h1>
          <span className="numeric shrink-0 text-[13px] text-[var(--text-faint)]">
            {t.home.itemCount(entries.length)}
          </span>
        </div>

        {entries.length === 0 ? (
          <div className="mt-10 rounded-[var(--radius-card)] bg-[var(--bg-sunken)] px-6 py-16 text-center">
            <p className="text-[15px]">{search ? t.home.noMatch : t.home.empty}</p>
            {!search && (
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[var(--text-muted)]">
                {t.home.emptyHint}
              </p>
            )}
          </div>
        ) : (
          // Dawn 的网格密度：手机 2 列、平板 3 列、桌面 4 列。
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {entries.map((entry) => (
              <ProductCard
                key={`${entry.supplierId}:${entry.code}`}
                entry={entry}
                currency={config.store.currency}
                t={t}
              />
            ))}
          </div>
        )}
      </main>

      <StoreFooter
        storeName={config.store.name}
        currency={config.store.currency}
        supportEmail={config.store.supportEmail ?? null}
        t={t}
      />

      {popups.length > 0 && (
        <AnnouncementPopup
          items={popups.map((item) => ({
            id: item.id,
            title: item.title,
            body: item.body,
          }))}
        />
      )}
    </>
  );
}
