/**
 * 桌面端两级分类树 —— Dawn collection 页的侧栏形态。
 *
 * 纯文字列表 + 当前项高亮：一级分类粗体，二级缩进小一号；激活项用左侧
 * 描边 + 加粗标记，不做填充色 —— 侧栏是编辑版式，不是按钮组。
 * 「全部商品」固定在树顶；一级分类无论有没有子分类都保持可点击，
 * 点一级等于看该一级下的全部商品（?c= 的展开语义见 page.tsx）。
 *
 * 数据来自 loadPage() 已加载的分类快照，这里只做树构建与渲染，不发查询。
 * 上游是平铺分类时所有行都是一级，自然退化成一列粗体链接。
 * 断点由 page.tsx 控制：本组件只出现在 md+，移动端仍是横滑的 CategoryNav。
 */

import Link from "next/link";

import type { Category } from "@/db/schema";
import type { Dict } from "@/i18n/dictionary";

export function CategoryTree({
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
  const childrenOf = new Map<string, Category[]>();
  for (const item of categories) {
    if (!item.parentId) continue;
    const siblings = childrenOf.get(item.parentId);
    if (siblings) siblings.push(item);
    else childrenOf.set(item.parentId, [item]);
  }

  // 左边框常驻占位（transparent → accent），切换激活项时文字不跳动。
  const rootLink = (isActive: boolean) =>
    `block border-l-2 py-1.5 pl-3 text-[14px] leading-snug transition-colors ${
      isActive
        ? "border-[var(--accent)] font-semibold text-[var(--text)]"
        : "border-transparent font-semibold text-[var(--text-muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
    }`;

  const childLink = (isActive: boolean) =>
    `block border-l-2 py-1 pl-3 text-[13px] leading-snug transition-colors ${
      isActive
        ? "border-[var(--accent)] font-medium text-[var(--text)]"
        : "border-transparent text-[var(--text-muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
    }`;

  return (
    <nav aria-label={t.nav.categories}>
      <ul>
        <li>
          <Link href="/" className={rootLink(!activeId)}>
            {t.nav.allCategories}
          </Link>
        </li>
        {roots.map((root) => {
          const children = childrenOf.get(root.externalId) ?? [];
          return (
            <li key={root.externalId}>
              <Link
                href={`/?c=${encodeURIComponent(root.externalId)}`}
                className={rootLink(root.externalId === activeId)}
              >
                {root.name}
              </Link>
              {children.length > 0 && (
                <ul className="ml-3">
                  {children.map((child) => (
                    <li key={child.externalId}>
                      <Link
                        href={`/?c=${encodeURIComponent(child.externalId)}`}
                        className={childLink(child.externalId === activeId)}
                      >
                        {child.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
