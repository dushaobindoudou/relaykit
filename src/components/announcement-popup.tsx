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
    // 导航「公告」按钮随时可再打开（tokyo-notice-trigger 同款交互）。
    const reopen = () => setOpen(true);
    window.addEventListener("tokyo:open-notice", reopen);
    return () => window.removeEventListener("tokyo:open-notice", reopen);
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
    <div id="tokyo-notice-popup" style={{ display: "block" }}>
      <div className="tokyo-notice-popup-inner">
        <div className="order-payment-notice__dialog" role="dialog" aria-modal="true">
          <header>
            <h3>{items[0]?.title}</h3>
            <button type="button" aria-label="Close" onClick={dismiss}>
              &times;
            </button>
          </header>
          <div className="order-payment-notice__content tokyo-notice-body">
            {items.map((item) => (
              <section key={item.id}>
                <div className="rte" dangerouslySetInnerHTML={{ __html: item.body }} />
              </section>
            ))}
          </div>
          <footer>
            <button type="button" className="order-payment-notice__confirm" onClick={dismiss}>
              OK
            </button>
          </footer>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className="order-payment-notice__backdrop"
      />
    </div>
  );
}
