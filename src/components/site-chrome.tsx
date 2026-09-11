/**
 * 站点外框与共用原语。
 *
 * 这里定义的少数几个组件承担整站的一致性。刻意**不建卡片组件** ——
 * 默认用发丝线和留白分组，只有当"抬升"真的表达层级时才用容器。
 * 满屏浮动卡片是模板味最重的来源之一。
 */

import Link from "next/link";

export function SiteHeader({
  storeName,
  currency,
}: {
  storeName: string;
  currency: string;
}) {
  return (
    // 单行、64px 高。导航栏吃掉视口高度是设计缺陷，不是气派。
    <header className="sticky top-0 z-20 h-16 border-b border-[var(--line)] bg-[var(--bg)]/85 backdrop-blur">
      <div className="mx-auto flex h-full max-w-5xl items-center justify-between gap-6 px-5">
        <Link href="/" className="text-[15px] font-semibold tracking-tight">
          {storeName}
        </Link>
        <nav className="flex items-center gap-6 text-[13px]">
          <span className="numeric hidden text-[var(--text-faint)] sm:inline">
            Prices in {currency}
          </span>
          <Link
            href="/lookup"
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
          >
            Find my order
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter({ supportEmail }: { supportEmail?: string | null }) {
  return (
    <footer className="mt-24 border-t border-[var(--line)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-[13px] text-[var(--text-faint)] sm:flex-row sm:items-center sm:justify-between">
        <p>
          Codes are delivered automatically after payment confirms on-chain.
        </p>
        {supportEmail ? (
          <a
            href={`mailto:${supportEmail}`}
            className="text-[var(--text-muted)] underline underline-offset-4 hover:text-[var(--text)]"
          >
            {supportEmail}
          </a>
        ) : null}
      </div>
    </footer>
  );
}

export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-5xl px-5 py-12 sm:py-16">{children}</main>;
}

/** 主操作按钮。全站只有一种主按钮样式。 */
export function PrimaryButton({
  children,
  type = "submit",
  disabled,
}: {
  children: React.ReactNode;
  type?: "submit" | "button";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      className="inline-flex h-11 items-center justify-center rounded-[var(--radius-card)] bg-[var(--accent)] px-6 text-[14px] font-medium text-[var(--accent-fg)] transition-[background-color,transform] hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

type ToneName = "ok" | "warn" | "danger" | "neutral" | "accent";

const TONE: Record<ToneName, string> = {
  ok: "bg-[var(--ok-wash)] text-[var(--ok)]",
  warn: "bg-[var(--warn-wash)] text-[var(--warn)]",
  danger: "bg-[var(--danger-wash)] text-[var(--danger)]",
  accent: "bg-[var(--accent-wash)] text-[var(--accent)]",
  neutral: "bg-[var(--bg-sunken)] text-[var(--text-muted)]",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: ToneName;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-[3px] px-2 py-1 text-[12px] font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** 提示条。用于「这站还不能收钱」这类必须被看见的事实。 */
export function Notice({
  tone = "warn",
  title,
  children,
}: {
  tone?: ToneName;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-current/15 px-4 py-3 text-[13px] leading-relaxed ${TONE[tone]}`}
    >
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 opacity-90">{children}</div> : null}
    </div>
  );
}

/**
 * 定义列表行。
 *
 * 订单详情这类「标签 + 值」的内容用它，而不是每行一个 border 的表格 ——
 * 每行都画横线是最偷懒的排版，读起来像账单打印机吐出来的。
 * 这里只在行之间留白，靠对齐建立结构。
 */
export function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <dt className="shrink-0 text-[13px] text-[var(--text-muted)]">{label}</dt>
      <dd className={`text-right text-[14px] ${mono ? "numeric" : ""}`}>{children}</dd>
    </div>
  );
}
