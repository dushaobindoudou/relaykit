"use client";

/**
 * 移动端分类抽屉控制 —— 源站 Tokyo 主题的抽屉机制 1:1：
 *
 * 768–1199px：侧栏变 off-canvas 抽屉，三个控件配合
 *   .tokyo-mobile-filter-trigger  目录工具里的「筛选分类」按钮（开）
 *   .tokyo-mobile-sidebar-backdrop  全屏遮罩（点关）
 *   .tokyo-mobile-sidebar-close    侧栏头部的 ✕（关）
 * 开关状态挂在 body.tokyo-mobile-drawer-open 上，展示全由主题 CSS 管。
 *
 * ≤767px 的手机上源站改用横滑分类轨，这三个控件被 CSS display:none
 * —— 标记照样渲染（和源站一致），桌面/手机都无害。
 *
 * 三个组件都不需要 state：事件处理器就是类名开关，纯客户端、可 SSR。
 */

function openDrawer() {
  document.body.classList.add("tokyo-mobile-drawer-open");
}

function closeDrawer() {
  document.body.classList.remove("tokyo-mobile-drawer-open");
}

export function MobileFilterTrigger({ label }: { label: string }) {
  return (
    <button type="button" className="tokyo-button tokyo-button-light tokyo-mobile-filter-trigger" onClick={openDrawer}>
      <i className="fa-duotone fa-regular fa-sliders" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export function MobileSidebarBackdrop() {
  return (
    <button type="button" className="tokyo-mobile-sidebar-backdrop" aria-label="关闭分类筛选" onClick={closeDrawer} />
  );
}

export function MobileSidebarClose() {
  return (
    <button type="button" className="tokyo-mobile-sidebar-close" aria-label="关闭分类" onClick={closeDrawer}>
      <i className="fa-duotone fa-regular fa-xmark" aria-hidden />
    </button>
  );
}
