/**
 * 店标 mark —— 「AI充站」品牌图形：充电 bolt + 充电口。
 *
 * 语义：bolt = 充值即到（快），底部横线 = 充电口（插上就充）。
 * 几何在三处消费，改图形必须三处同步：
 *   1. src/components/brand-mark.tsx（本文件，页头内联）
 *   2. src/app/icon.svg（favicon）
 *   3. scripts/generate-brand-assets.ts（og 卡/apple-touch 位图重绘）
 * 底色永远吃 var(--pop)/var(--bg) token —— 暗黑模式靠它翻转。
 */

export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="7" fill="var(--pop, #1C5F45)" />
      {/* 充电 bolt */}
      <path d="M18.2 4 L10 17 H15.2 L13.6 22.5 L22.2 11.5 H16.6 Z" fill="var(--bg, #F7F5F2)" />
      {/* 充电口 */}
      <path
        d="M9.5 25.5 H22.5"
        fill="none"
        stroke="var(--bg, #F7F5F2)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
