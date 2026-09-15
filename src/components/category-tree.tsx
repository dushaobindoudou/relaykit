/**
 * 侧栏分类树 —— 结构照搬源站 Tokyo 主题（tokyo-category-node 体系）。
 *
 * 源站是 JS 拉取后渲染；我们直接服务端渲染同样的 DOM。展开行为用
 * 原生 <details>：零 JS、可无障碍操作，展开态与源站的 chevron 旋转一致。
 * 图标沿用源站的做法：分类有 icon 用 icon，没有就落到站标。
 *
 * 数据来自 loadPage() 已加载的分类快照，这里只做树构建与渲染，不发查询。
 */

import Link from "next/link";

import type { Category } from "@/db/schema";

interface TreeNode {
  category: Category;
  children: TreeNode[];
}

function buildTree(categories: Category[]): TreeNode[] {
  const byParent = new Map<string, TreeNode[]>();
  for (const category of categories) {
    const node: TreeNode = { category, children: [] };
    const key = category.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  const attach = (node: TreeNode) => {
    node.children = byParent.get(node.category.externalId) ?? [];
    node.children.forEach(attach);
  };
  const roots = byParent.get("") ?? [];
  roots.forEach(attach);
  return roots;
}

function CategoryRow({
  node,
  activeId,
  depth,
  fallbackIcon,
}: {
  node: TreeNode;
  activeId?: string | undefined;
  depth: number;
  fallbackIcon: string;
}) {
  const { category, children } = node;
  const isActive = category.externalId === activeId;
  const hasChildren = children.length > 0;
  const icon = category.icon || fallbackIcon;
  const href = `/?c=${encodeURIComponent(category.externalId)}`;

  // 与源站一致：行内嵌 --tokyo-depth 缩进变量，子级跟随展开。
  const rowStyle = { "--tokyo-depth": depth } as React.CSSProperties;

  const copy = (
    <>
      <span
        className="tokyo-category-icon"
        style={{ backgroundImage: `url('${icon}')` }}
        aria-hidden
      />
      <span className="tokyo-category-copy">
        <span className="tokyo-category-name">{category.name}</span>
        <span className="tokyo-category-side">
          {hasChildren ? (
            <span className="tokyo-category-toggle" aria-hidden>
              <i className="fa-duotone fa-regular fa-angle-right" />
            </span>
          ) : (
            <span className="tokyo-category-count">{category.sellableCount}</span>
          )}
        </span>
      </span>
    </>
  );

  if (!hasChildren) {
    return (
      <div className="tokyo-category-node">
        <div className="tokyo-category-row" style={rowStyle}>
          <Link className={`tokyo-category-link${isActive ? " is-active" : ""}`} href={href}>
            {copy}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="tokyo-category-node">
      {/* 有子分类：summary 负责展开，名称区仍是分类链接本身。 */}
      <details open={depth === 0}>
        <summary className="tokyo-category-row" style={rowStyle}>
          <Link className={`tokyo-category-link${isActive ? " is-active" : ""}`} href={href}>
            {copy}
          </Link>
        </summary>
        <div className="tokyo-category-children">
          {children.map((child) => (
            <CategoryRow
              key={child.category.externalId}
              node={child}
              activeId={activeId}
              depth={depth + 1}
              fallbackIcon={fallbackIcon}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

export function CategoryTree({
  categories,
  activeId,
  fallbackIcon = "/icon.svg",
}: {
  categories: Category[];
  activeId?: string | undefined;
  fallbackIcon?: string;
}) {
  const roots = buildTree(categories);
  if (roots.length === 0) return null;

  return (
    <div className="tokyo-category-tree" id="tokyo-category-tree">
      {roots.map((node) => (
        <CategoryRow
          key={node.category.externalId}
          node={node}
          activeId={activeId}
          depth={0}
          fallbackIcon={fallbackIcon}
        />
      ))}
    </div>
  );
}
