/**
 * 首页 —— 结构照搬源站 zhanghao66.com 的 Tokyo 主题。
 *
 * 源站形态：左侧分类树 + 右侧商品表格（商品/价格/库存/操作），
 * 表格行是 thumb 背景图 + 名称/标签 pill + 价格栈 + 库存 + 购买链接。
 * 差异：源站是 JS 拉取（默认空表提示选分类），我们服务端直渲染
 * 全部在架商品 —— 视觉同款，首屏更快，SEO 也吃得到商品名。
 */

import Link from "next/link";

import { listCatalog, type CatalogEntry } from "@/catalog/sync";
import type { Category } from "@/db/schema";
import { isPlaceholderAddress } from "@/config/schema";
import { CategoryTree } from "@/components/category-tree";
import { StoreHeader } from "@/components/storefront";
import { SearchBox } from "@/components/search-box";
import {
  MobileFilterTrigger,
  MobileSidebarBackdrop,
  MobileSidebarClose,
} from "@/components/mobile-sidebar";
import type { Dict } from "@/i18n/dictionary";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";

/**
 * 移动端横滑分类轨 —— 源站 ≤767px 的形态（侧栏隐藏，双轨芯片替代）。
 *
 * 源站是 JS 点击切换（一级点击 → 二级轨重渲染），我们是纯链接：
 * 一级芯片带图标，二级芯片带数量/下钻箭头，active 态由 URL 决定。
 * 链接可爬 —— 移动优先索引下这些分类词全部进入首屏 HTML。
 */
function MobileCategoryPanel({
  categories,
  activeId,
  t,
}: {
  categories: Category[];
  activeId: string | undefined;
  t: Dict;
}) {
  const topLevel = categories.filter((item) => !item.parentId);
  if (topLevel.length === 0) return null;

  // 当前激活分类所属的一级分类（未选分类时默认第一个，与源站 defaultCategory 行为一致）。
  const active = categories.find((item) => item.externalId === activeId);
  const primaryId =
    (active
      ? [...categories].find((item) => !item.parentId && (item.externalId === activeId || item.externalId === active.parentId))?.externalId
      : topLevel[0]?.externalId) ?? topLevel[0]?.externalId;
  const children = categories.filter((item) => item.parentId === primaryId);

  return (
    <section
      className="panel tokyo-mobile-category-panel"
      id="tokyo-mobile-category-panel"
      aria-label={t.nav.categories}
    >
      <div className="tokyo-mobile-category-head">
        <div>
          <span className="panel-kicker">Categories</span>
          <h2 className="panel-title tokyo-mobile-category-title">{t.nav.mobileSwipeTitle}</h2>
        </div>
        <span className="tokyo-mobile-category-hint">{t.nav.mobileSwipeHint}</span>
      </div>
      <div className="tokyo-mobile-category-body">
        <div className="tokyo-mobile-category-line">
          <span className="tokyo-mobile-category-label">{t.nav.mobileLevel1}</span>
          <div className="tokyo-mobile-category-rail tokyo-mobile-category-primary">
            {topLevel.map((item) => (
              <a
                key={item.externalId}
                className={`tokyo-mobile-category-chip tokyo-mobile-category-chip-primary${item.externalId === primaryId ? " is-active" : ""}`}
                href={`/?c=${encodeURIComponent(item.externalId)}`}
              >
                <span
                  className="tokyo-mobile-category-chip-icon"
                  style={{ backgroundImage: `url('${item.icon || "/icon.svg"}')` }}
                />
                <span className="tokyo-mobile-category-chip-text">{item.name}</span>
              </a>
            ))}
          </div>
        </div>
        <div className="tokyo-mobile-category-line tokyo-mobile-category-line-secondary">
          <span className="tokyo-mobile-category-label">{t.nav.mobileLevel2}</span>
          <div className="tokyo-mobile-category-rail tokyo-mobile-category-secondary">
            {children.length === 0 ? (
              <span className="tokyo-mobile-category-loading">{t.nav.mobileNoSub}</span>
            ) : (
              children.map((item) => {
                const grandChildren = categories.some((c) => c.parentId === item.externalId);
                return (
                  <a
                    key={item.externalId}
                    className={`tokyo-mobile-category-chip tokyo-mobile-category-chip-secondary${item.externalId === activeId ? " is-active" : ""}`}
                    href={`/?c=${encodeURIComponent(item.externalId)}`}
                  >
                    <span className="tokyo-mobile-category-chip-text">{item.name}</span>
                    {grandChildren ? (
                      <i className="fa-duotone fa-regular fa-angle-right" aria-hidden />
                    ) : (
                      <span className="tokyo-mobile-category-count">{item.sellableCount}</span>
                    )}
                  </a>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * 商品行 —— 源站 Index.js 的行模板 1:1（thumb 背景图 + 名称 + pill 标签 +
 * 价格栈 + 库存 + 操作列）。售罄/预订状态挂在行类名上，配色交给主题。
 */
function CommodityRow({ entry, t }: { entry: CatalogEntry; t: Dict }) {
  const soldOut = entry.totalStock <= 0;
  const href = `/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`;
  const rowState = soldOut ? (entry.reservable ? " is-reserve" : " is-soldout") : "";

  const action = soldOut ? (
    entry.reservable ? (
      <a className="tokyo-commodity-action-link" href={href}>
        <i className="fa-duotone fa-regular fa-calendar-check" aria-hidden />
        <span>{t.product.reserve}</span>
      </a>
    ) : (
      <span className="tokyo-commodity-action-disabled">
        <i className="fa-duotone fa-regular fa-ban" aria-hidden />
        <span>{t.product.outOfStock}</span>
      </span>
    )
  ) : (
    <a className="tokyo-commodity-action-link" href={href}>
      <i className="fa-duotone fa-regular fa-bag-shopping" aria-hidden />
      <span>{t.product.buy}</span>
    </a>
  );

  return (
    <tr className={`tokyo-commodity-row${rowState}`}>
      <td className="tokyo-commodity-main">
        <a className="tokyo-commodity-anchor" href={href}>
          <span
            className="tokyo-commodity-thumb"
            style={{ backgroundImage: `url('${entry.cover ?? "/icon.svg"}')` }}
          />
          <span className="tokyo-commodity-copy">
            <span className="tokyo-commodity-name">{entry.name}</span>
            <span className="tokyo-commodity-tags">
              <span className="tokyo-pill tokyo-pill-mobile-meta tokyo-pill-mobile-only">
                {entry.fromPrice} USDT
              </span>
              {entry.deliveryWay === "auto" && (
                <span className="tokyo-pill tokyo-pill-auto">{t.product.autoDelivery}</span>
              )}
              {soldOut && entry.reservable && (
                <span className="tokyo-pill tokyo-pill-auto">{t.product.reservable}</span>
              )}
              {entry.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="tokyo-pill tokyo-pill-tag">
                  {tag}
                </span>
              ))}
            </span>
          </span>
        </a>
      </td>
      <td className="tokyo-commodity-price" data-label={t.product.columnPrice}>
        <span className="tokyo-commodity-price-stack">
          <span className="tokyo-commodity-price-main">{entry.fromPrice}</span>
          <span className="tokyo-commodity-price-note">USDT</span>
        </span>
      </td>
      <td className="tokyo-commodity-muted" data-label={t.product.columnStock}>
        {soldOut
          ? entry.reservable
            ? t.product.reservable
            : t.product.outOfStock
          : entry.stockText}
      </td>
      <td className="tokyo-commodity-action" data-label={t.product.cellAction}>
        {action}
      </td>
    </tr>
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
      <main className="checkout-page">
        <section className="checkout-shell" style={{ maxWidth: 640 }}>
          <div className="checkout-body">
            <h1 className="text-[20px] font-bold">{t.setup.title}</h1>
            <p className="text-[14px] text-[#60646c]">{t.setup.intro}</p>
            <pre className="overflow-x-auto rounded-xl bg-[#f7f8fa] p-4 text-[13px] leading-relaxed">
              {loaded.error}
            </pre>
            <p className="text-[13px] text-[#60646c]">
              {t.setup.diagnostics}{" "}
              <Link href="/api/health" className="text-[#0d74ce]">
                /api/health
              </Link>
            </p>
          </div>
        </section>
      </main>
    );
  }

  const { context, locale, t, user, categories, popups } = loaded.page;
  const { config } = context;

  const activeCategory = categories.find((item) => item.externalId === categoryId);
  // 点一级分类 = 看该一级下的全部商品：过滤范围展开为「本分类 + 直接子分类」。
  const categoryFilter = activeCategory
    ? [
        activeCategory.externalId,
        ...categories
          .filter((item) => item.parentId === activeCategory.externalId)
          .map((item) => item.externalId),
      ]
    : undefined;

  const entries = await listCatalog(context, {
    ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    ...(search ? { search } : {}),
  });

  const unpayable = config.payments.chains
    .filter((chain) => chain.enabled && isPlaceholderAddress(chain.address))
    .map((chain) => chain.id);
  const canSell = unpayable.length < config.payments.chains.filter((c) => c.enabled).length;

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

      <main className="tokyo-main tokyo-page">
        <section className="tokyo-shell">
          {!canSell && (
            <section className="warning-panel" style={{ marginBottom: 16 }}>
              <div className="warning-title">
                <span className="warning-icon">!</span>
                <span>{t.setup.demoMode}</span>
              </div>
              <p className="warning-note">{t.setup.demoBody(unpayable.join(", "))}</p>
            </section>
          )}

          {/* ≤767px 手机：横滑分类轨（侧栏在该断点隐藏，源站同款） */}
          {categories.length > 0 && (
            <MobileCategoryPanel categories={categories} activeId={categoryId} t={t} />
          )}

          {/* 源站骨架：侧栏树 + 商品目录表。无分类时侧栏隐藏。 */}
          <section className="tokyo-shop-layout">
            <MobileSidebarBackdrop />
            {categories.length > 0 && (
              <aside className="panel tokyo-sidebar-panel">
                <div className="panel-header tokyo-index-heading">
                  <div className="tokyo-index-heading-copy">
                    <span className="panel-kicker">Categories</span>
                    <h2 className="panel-title tokyo-index-panel-title">{t.nav.categories}</h2>
                  </div>
                  <MobileSidebarClose />
                </div>
                <div className="panel-body">
                  <CategoryTree categories={categories} activeId={categoryId} />
                </div>
              </aside>
            )}

            <section className="panel tokyo-catalog-panel">
              <div className="panel-header tokyo-catalog-heading">
                <div className="tokyo-index-heading-copy">
                  <span className="panel-kicker">Catalog</span>
                  <h2 className="panel-title tokyo-current-name tokyo-index-panel-title">
                    {activeCategory ? activeCategory.name : t.nav.allCategories}
                  </h2>
                </div>
                <div className="tokyo-catalog-tools">
                  <MobileFilterTrigger label={t.nav.mobileFilter} />
                  <div className="tokyo-search-combo">
                    <SearchBox placeholder={t.nav.search} defaultValue={search ?? ""} />
                  </div>
                </div>
              </div>
              <div className="panel-body">
                <div className="tokyo-table-wrap">
                  <table className="tokyo-commodity-table">
                    <colgroup>
                      <col className="tokyo-commodity-col-main" />
                      <col className="tokyo-commodity-col-price" />
                      <col className="tokyo-commodity-col-stock" />
                      <col className="tokyo-commodity-col-action" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>{t.product.columnItem}</th>
                        <th>{t.product.columnPrice}</th>
                        <th>{t.product.columnStock}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody className="item-list">
                      {entries.length === 0 ? (
                        <tr className="tokyo-empty-row">
                          <td colSpan={4}>{search ? t.home.noMatch : t.home.empty}</td>
                        </tr>
                      ) : (
                        entries.map((entry) => (
                          <CommodityRow
                            key={`${entry.supplierId}:${entry.code}`}
                            entry={entry}
                            t={t}
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </section>
        </section>
      </main>

      {/* 首页结构化数据（WebSite + Organization）。 */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebSite", name: config.store.name, url: config.store.baseUrl },
              {
                "@type": "Organization",
                name: config.store.name,
                url: config.store.baseUrl,
                logo: config.store.baseUrl ? `${config.store.baseUrl}/icon.svg` : undefined,
              },
            ],
          }),
        }}
      />

    </>
  );
}
