/**
 * 店面骨架组件 —— 结构照搬 Shopify Dawn。
 *
 * Dawn 的纵向骨架：公告条 → 白头部 → 内容 → 多列页脚。
 * 分类不做成常驻左侧栏（那是后台的形态），而是 Dawn 的做法：
 * 头部下方一条可横滑的分类导航。商品少时它比侧栏更省空间，
 * 商品多时横滑比纵向长列表更适合触屏。
 */

import Link from "next/link";

import type { Category } from "@/db/schema";
import type { Dict, Locale } from "@/i18n/dictionary";
import { LocaleSwitch } from "@/components/locale-switch";
import { SearchBox } from "@/components/search-box";

/** 顶部公告条。Dawn 的第一行，整站最先被看到的位置。 */
export function AnnouncementBar({ text }: { text: string }) {
  return (
    <div className="bg-[var(--accent)] px-4 py-2 text-center text-[13px] text-[var(--accent-fg)]">
      {text}
    </div>
  );
}

export function StoreHeader({
  storeName,
  locale,
  t,
  user,
  showSearch = true,
  search,
}: {
  storeName: string;
  locale: Locale;
  t: Dict;
  user: { email: string; balance: string } | null;
  showSearch?: boolean;
  search?: string | undefined;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--bg)]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="shrink-0 text-[17px] font-semibold tracking-tight">
          {storeName}
        </Link>

        {showSearch ? (
          <div className="ml-2 hidden min-w-0 flex-1 md:block">
            <SearchBox placeholder={t.nav.search} defaultValue={search ?? ""} />
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <nav className="ml-auto flex shrink-0 items-center gap-4 text-[13px]">
          <Link
            href="/help"
            className="hidden text-[var(--text-muted)] hover:text-[var(--text)] sm:inline"
          >
            {t.nav.help}
          </Link>
          <Link href="/lookup" className="text-[var(--text-muted)] hover:text-[var(--text)]">
            {t.nav.findOrder}
          </Link>
          {user ? (
            <Link
              href="/account"
              className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--line-strong)] px-2.5 py-1.5"
            >
              <span className="numeric text-[var(--pop)]">{user.balance}</span>
              <span className="max-w-[9ch] truncate text-[var(--text-muted)]">
                {user.email.split("@")[0]}
              </span>
            </Link>
          ) : (
            <Link
              href="/account/login"
              className="rounded-[var(--radius-card)] border border-[var(--line-strong)] px-2.5 py-1.5 hover:border-[var(--text)]"
            >
              {t.nav.signIn}
            </Link>
          )}
          <LocaleSwitch current={locale} />
        </nav>
      </div>

      {showSearch && (
        <div className="border-t border-[var(--line)] px-4 py-2 md:hidden">
          <SearchBox placeholder={t.nav.search} defaultValue={search ?? ""} />
        </div>
      )}
    </header>
  );
}

/**
 * 分类横滑导航。
 *
 * 二级分类挂在一级下面 —— 上游支持两级，只展示一级会丢掉它的组织方式。
 * 这里把选中一级下的二级分类展开成第二行，是实体店导购的通行做法。
 */
export function CategoryNav({
  categories,
  activeId,
  t,
}: {
  categories: Category[];
  activeId?: string | undefined;
  t: Dict;
}) {
  if (categories.length === 0) return null;

  const roots = categories.filter((item) => !item.parentId);
  const active = categories.find((item) => item.externalId === activeId);
  // 选中二级分类时，第二行仍要展示它所属一级的兄弟项。
  const activeRootId = active?.parentId ?? active?.externalId;
  const children = categories.filter((item) => item.parentId === activeRootId);

  const pill = (isActive: boolean) =>
    `shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${
      isActive
        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
        : "border-[var(--line-strong)] text-[var(--text-muted)] hover:border-[var(--text)] hover:text-[var(--text)]"
    }`;

  return (
    <div className="border-b border-[var(--line)]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex gap-2 overflow-x-auto py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Link href="/" className={pill(!activeId)}>
            {t.nav.allCategories}
          </Link>
          {roots.map((category) => (
            <Link
              key={category.externalId}
              href={`/?c=${encodeURIComponent(category.externalId)}`}
              className={pill(category.externalId === activeRootId)}
            >
              {category.name}
              <span className="numeric ml-1.5 opacity-60">{category.sellableCount}</span>
            </Link>
          ))}
        </div>

        {children.length > 0 && (
          <div className="flex gap-2 overflow-x-auto border-t border-[var(--line)] py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {children.map((child) => (
              <Link
                key={child.externalId}
                href={`/?c=${encodeURIComponent(child.externalId)}`}
                className={`shrink-0 whitespace-nowrap text-[13px] ${
                  child.externalId === activeId
                    ? "font-medium text-[var(--text)] underline underline-offset-4"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {child.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function StoreFooter({
  storeName,
  currency,
  supportEmail,
  t,
}: {
  storeName: string;
  currency: string;
  supportEmail: string | null;
  t: Dict;
}) {
  return (
    <footer className="mt-20 border-t border-[var(--line)] bg-[var(--bg-sunken)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div>
          <p className="text-[15px] font-semibold">{storeName}</p>
          <p className="mt-2 max-w-xs text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t.footer.note}
          </p>
        </div>

        <div>
          <p className="eyebrow">{t.footer.shop}</p>
          <ul className="mt-3 grid gap-2 text-[13px]">
            <li>
              <Link href="/" className="text-[var(--text-muted)] hover:text-[var(--text)]">
                {t.nav.allCategories}
              </Link>
            </li>
            <li>
              <Link href="/help" className="text-[var(--text-muted)] hover:text-[var(--text)]">
                {t.nav.help}
              </Link>
            </li>
            <li>
              <Link href="/lookup" className="text-[var(--text-muted)] hover:text-[var(--text)]">
                {t.nav.findOrder}
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="eyebrow">{t.footer.support}</p>
          <ul className="mt-3 grid gap-2 text-[13px]">
            {supportEmail && (
              <li>
                <a
                  href={`mailto:${supportEmail}`}
                  className="text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  {supportEmail}
                </a>
              </li>
            )}
            <li className="numeric text-[var(--text-faint)]">
              {t.nav.pricesIn(currency)}
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
