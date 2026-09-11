"use client";

import { useState } from "react";

/** 窄屏下的分类抽屉。桌面端侧栏常驻，这里只负责小屏。 */
export function MobileCategoryDrawer({
  storeName,
  label,
  children,
}: {
  storeName: string;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className="shrink-0 rounded-[var(--radius-card)] border border-[var(--line-strong)] px-2.5 py-1.5 text-[13px] lg:hidden"
      >
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute inset-y-0 left-0 flex w-[268px] flex-col bg-[var(--bg-sunken)]">
            <div className="flex items-center justify-between px-4 py-4">
              <span className="text-[15px] font-semibold">{storeName}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-2 text-[18px] leading-none text-[var(--text-muted)]"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {/* 点任意分类后关闭抽屉：链接导航不会卸载这个组件。 */}
            <div
              className="flex-1 overflow-y-auto px-3 pb-6"
              onClick={() => setOpen(false)}
            >
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
