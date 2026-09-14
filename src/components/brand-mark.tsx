/**
 * 店标 mark —— 与 src/app/icon.svg 同一个图形的两处消费之一。
 *
 * 不做成独立文件引用而是内联组件：头部 18px 尺寸下要跟文字基线对齐，
 * 内联才能吃到 currentColor 与行高。改动图形时两处要同步改。
 * （第三处是 og 卡：scripts/generate-brand-assets.ts 里按同几何重绘。）
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
      <path
        d="M9.5 22.5 L16 9.5 L22.5 22.5"
        fill="none"
        stroke="var(--bg, #F7F5F2)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.8 18.2 H19.2"
        fill="none"
        stroke="var(--bg, #F7F5F2)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
