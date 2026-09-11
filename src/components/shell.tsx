/**
 * 店面外框：左侧分类栏 + 主内容区。
 *
 * 这是发卡站的固有结构 —— 商品挂在分类树下，买家的主要动作是「按分类找东西」。
 * 之前做成单一扁平列表是错的：商品一多就没法浏览。
 *
 * 视觉参照现代购买站的通行做法（ChatGPT 那类）：侧栏是低对比度的次要表面，
 * 内容区是主表面，两者靠背景色分层而不是靠边框和阴影堆叠。
 */

import Link from "next/link";

import type { Category } from "@/db/schema";
import type { Dict, Locale } from "@/i18n/dictionary";
import { LocaleSwitch } from "@/components/locale-switch";
import { MobileCategoryDrawer } from "@/components/mobile-drawer";
import { SearchBox } from "@/components/search-box";

export interface ShellProps {
  storeName: string;
  currency: string;
  categories: Category[];
  activeCategoryId?: string | undefined;
  locale: Locale;
  t: Dict;
  children: React.ReactNode;
  /** 商品页等不需要侧栏的页面传 false。 */
  withSidebar?: boolean;
  search?: string | undefined;
}

function CategoryList({
  categories,
  activeCategoryId,
  t,
}: {
  categories: Category[];
  activeCategoryId?: string | undefined;
  t: Dict;
}) {
  const linkClass = (active: boolean) =>
    `flex items-center justify-between gap-2 rounded-[var(--radius-card)] px-3 py-2 text-[14px] transition-colors ${
      active
        ? "bg-[var(--accent-wash)] font-medium text-[var(--accent)]"
        : "text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
    }`;

  return (
    <nav className="grid gap-0.5">
      <Link href="/" className={linkClass(!activeCategoryId)}>
        <span>{t.nav.allCategories}</span>
      </Link>
      {categories.map((category) => (
        <Link
          key={category.externalId}
          href={`/?c=${encodeURIComponent(category.externalId)}`}
          className={linkClass(category.externalId === activeCategoryId)}
        >
          <span className="truncate">{category.name}</span>
          {/* 数量用等宽，竖着扫的时候不会跳。 */}
          <span className="numeric shrink-0 text-[12px] text-[var(--text-faint)]">
            {category.sellableCount}
          </span>
        </Link>
      ))}
    </nav>
  );
}

export function Shell({
  storeName,
  currency,
  categories,
  activeCategoryId,
  locale,
  t,
  children,
  withSidebar = true,
  search,
}: ShellProps) {
  const showSidebar = withSidebar && categories.length > 0;

  return (
    <div className="min-h-[100dvh] lg:flex">
      {showSidebar && (
        <aside className="hidden w-[248px] shrink-0 border-r border-[var(--line)] bg-[var(--bg-sunken)] lg:block">
          {/* 侧栏整体吸顶：分类多时主内容滚动，分类导航保持可见。 */}
          <div className="sticky top-0 flex h-[100dvh] flex-col">
            <div className="px-4 py-5">
              <Link href="/" className="text-[15px] font-semibold tracking-tight">
                {storeName}
              </Link>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-6">
              <CategoryList
                categories={categories}
                activeCategoryId={activeCategoryId}
                t={t}
              />
            </div>
            <div className="border-t border-[var(--line)] px-4 py-3">
              <LocaleSwitch current={locale} />
            </div>
          </div>
        </aside>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[var(--bg)]/90 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6">
            {showSidebar ? (
              <MobileCategoryDrawer storeName={storeName} label={t.nav.products}>
                <CategoryList
                  categories={categories}
                  activeCategoryId={activeCategoryId}
                  t={t}
                />
              </MobileCategoryDrawer>
            ) : (
              <Link
                href="/"
                className="text-[15px] font-semibold tracking-tight lg:hidden"
              >
                {storeName}
              </Link>
            )}

            {withSidebar ? (
              <SearchBox placeholder={t.nav.search} defaultValue={search ?? ""} />
            ) : (
              <div className="flex-1" />
            )}

            <Link
              href="/lookup"
              className="shrink-0 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
            >
              {t.nav.findOrder}
            </Link>
          </div>
        </header>

        <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>

        <footer className="mx-auto max-w-4xl px-4 pb-10 sm:px-6">
          <div className="flex flex-col gap-3 border-t border-[var(--line)] pt-6 text-[13px] text-[var(--text-faint)] sm:flex-row sm:items-center sm:justify-between">
            <p>{t.footer.note}</p>
            <div className="flex items-center gap-4">
              <span className="numeric">{t.nav.pricesIn(currency)}</span>
              <div className="lg:hidden">
                <LocaleSwitch current={locale} />
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
