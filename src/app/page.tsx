import Link from "next/link";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { listCatalog, listCategories, type CatalogEntry } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { Badge, Notice } from "@/components/site-chrome";
import { Shell } from "@/components/shell";
import { getI18n } from "@/i18n";
import type { Dict } from "@/i18n/dictionary";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

function ProductRow({
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
    <li>
      <Link
        href={`/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`}
        className="group flex items-center gap-4 border-b border-[var(--line)] py-4 transition-colors hover:bg-[var(--bg-sunken)]"
      >
        {entry.cover ? (
          // 上游给的封面。不用 next/image：Workers 上没有 sharp，
          // 而且这些是外站图片，交给浏览器直出更简单可靠。
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.cover}
            alt=""
            loading="lazy"
            className="h-11 w-11 shrink-0 rounded-[var(--radius-card)] object-cover"
          />
        ) : (
          <div className="h-11 w-11 shrink-0 rounded-[var(--radius-card)] bg-[var(--bg-sunken)]" />
        )}

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-medium group-hover:text-[var(--accent)]">
            {entry.name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--text-faint)]">
            <span>
              {entry.deliveryWay === "auto"
                ? t.product.autoDelivery
                : t.product.manualDelivery}
            </span>
            {entry.variants.length > 1 && (
              <span>{t.product.options(entry.variants.length)}</span>
            )}
            {/* 上游隐藏库存数字时给的是文案（"充足"），原样展示。 */}
            {entry.stockText && <span>{entry.stockText}</span>}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className="numeric text-[16px] font-semibold">
            {entry.variants.length > 1 && (
              <span className="mr-1 font-sans text-[11px] font-normal text-[var(--text-faint)]">
                {t.product.from}
              </span>
            )}
            {entry.fromPrice}
          </p>
          <p className="text-[11px] text-[var(--text-faint)]">{currency}</p>
        </div>
      </Link>
    </li>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; q?: string }>;
}) {
  const { c: categoryId, q: search } = await searchParams;
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);

  if (!result.ok || !result.context) {
    const { locale, t } = await getI18n("en");
    return (
      <Shell
        storeName="RelayKit"
        currency="USDT"
        categories={[]}
        locale={locale}
        t={t}
        withSidebar={false}
      >
        <h1 className="text-[22px] font-semibold tracking-tight">{t.setup.title}</h1>
        <p className="mt-2 text-[14px] text-[var(--text-muted)]">{t.setup.intro}</p>
        <pre className="mt-5 overflow-x-auto rounded-[var(--radius-card)] bg-[var(--bg-sunken)] p-4 text-[13px] leading-relaxed">
          {result.error ?? "unknown"}
        </pre>
        <p className="mt-4 text-[13px] text-[var(--text-muted)]">
          {t.setup.diagnostics}{" "}
          <Link href="/api/health" className="text-[var(--accent)] underline underline-offset-4">
            /api/health
          </Link>
        </p>
      </Shell>
    );
  }

  const context = result.context;
  const { config } = context;
  const { locale, t } = await getI18n(config.store.locale);

  const [categories, entries] = await Promise.all([
    listCategories(context),
    listCatalog(context, {
      ...(categoryId ? { categoryId } : {}),
      ...(search ? { search } : {}),
    }),
  ]);

  const unpayable = config.payments.chains
    .filter((chain) => chain.enabled && isPlaceholderAddress(chain.address))
    .map((chain) => chain.id);
  const canSell = config.payments.chains.some(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );

  const activeCategory = categories.find((item) => item.externalId === categoryId);

  return (
    <Shell
      storeName={config.store.name}
      currency={config.store.currency}
      categories={categories}
      activeCategoryId={categoryId}
      locale={locale}
      t={t}
      search={search}
    >
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-[20px] font-semibold tracking-tight">
          {activeCategory ? activeCategory.name : t.nav.allCategories}
        </h1>
        <span className="numeric shrink-0 text-[13px] text-[var(--text-faint)]">
          {t.home.itemCount(entries.length)}
        </span>
      </div>

      {!canSell && (
        <div className="mt-5">
          <Notice title={t.setup.demoMode}>{t.setup.demoBody(unpayable.join(", "))}</Notice>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="mt-8 border-t border-[var(--line)] pt-10">
          <p className="text-[15px]">{search ? t.home.noMatch : t.home.empty}</p>
          {!search && (
            <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-[var(--text-muted)]">
              {t.home.emptyHint}{" "}
              <Link href="/api/health" className="text-[var(--accent)] underline underline-offset-4">
                /api/health
              </Link>
            </p>
          )}
        </div>
      ) : (
        <ul className="mt-5 border-t border-[var(--line)]">
          {entries.map((entry) => (
            <ProductRow
              key={`${entry.supplierId}:${entry.code}`}
              entry={entry}
              currency={config.store.currency}
              t={t}
            />
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          <Badge tone="ok">{t.product.autoDelivery}</Badge>
          <Badge>
            {config.payments.chains
              .filter((chain) => chain.enabled && !isPlaceholderAddress(chain.address))
              .map((chain) => chain.id.toUpperCase())
              .join(" / ") || t.buy.notConfigured}
          </Badge>
        </div>
      )}
    </Shell>
  );
}
