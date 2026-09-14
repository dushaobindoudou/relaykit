"use client";

import { useEffect, useState } from "react";

/**
 * 公告弹窗。原站的做法，首次访问弹一次。
 *
 * 用 localStorage 按内容指纹记忆「已读」：公告改了就再弹一次，没改就不烦人。
 * 按 id 记会让改了内容的公告永远弹不出来，按时间记会每天都弹。
 */
export function AnnouncementPopup({
  items,
}: {
  items: { id: number; title: string; body: string }[];
}) {
  const [open, setOpen] = useState(false);

  const signature = items.map((item) => `${item.id}:${item.body.length}`).join("|");

  useEffect(() => {
    try {
      if (localStorage.getItem("daichong_notice") !== signature) setOpen(true);
    } catch {
      // 隐私模式下 localStorage 会抛。弹一次总比崩掉好。
      setOpen(true);
    }
  }, [signature]);

  function dismiss() {
    setOpen(false);
    try {
      localStorage.setItem("daichong_notice", signature);
    } catch {
      /* 记不住就下次再弹，不影响功能 */
    }
  }

  if (!open || items.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className="absolute inset-0 bg-black/45"
      />
      <div className="relative max-h-[80dvh] w-full max-w-md overflow-y-auto rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--bg-raised)] p-6 shadow-xl">
        {items.map((item) => (
          <section key={item.id} className="mb-5 last:mb-0">
            <h2 className="text-[16px] font-semibold">{item.title}</h2>
            <div
              className="rte mt-2 text-[14px] text-[var(--text-muted)]"
              dangerouslySetInnerHTML={{ __html: item.body }}
            />
          </section>
        ))}
        <button
          type="button"
          onClick={dismiss}
          className="mt-4 h-11 w-full rounded-[var(--radius-card)] bg-[var(--accent)] text-[14px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
        >
          OK
        </button>
      </div>
    </div>
  );
}
