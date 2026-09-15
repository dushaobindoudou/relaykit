"use client";

/**
 * 导航「公告」按钮 —— 源站 tokyo-notice-trigger 同款交互：
 * 点击重新打开公告弹窗。弹窗本体在 StoreHeader 里渲染，
 * 这里只广播打开事件（弹窗监听 tokyo:open-notice）。
 */
export function NoticeTrigger({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="nav-link tokyo-nav-link tokyo-notice-trigger"
      onClick={() => window.dispatchEvent(new CustomEvent("tokyo:open-notice"))}
    >
      <i className="fa-duotone fa-regular fa-megaphone" aria-hidden />
      <span>{label}</span>
    </button>
  );
}
