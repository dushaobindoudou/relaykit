"use client";

import { useEffect, useState } from "react";

/**
 * 公告弹窗 —— 源站 tokyo-notice-modal 的同款结构与行为：
 *
 *   头部（Notice kicker + 喇叭标题）→ 富文本内容 →
 *   取消 / 我已阅读 两颗按钮 → 提示语
 *
 * 行为（照源站 Index.js）：
 *   - 首屏自动弹出；点「我已阅读」记 localStorage（tokyo_notice_ack_v1），
 *     同一内容 1 小时内不再自动弹；「取消」和点遮罩只关不记。
 *   - 导航「公告」按钮广播 tokyo:open-notice 事件，随时可手动重开。
 */

export interface NoticePopupCopy {
  title: string;
  cancel: string;
  confirm: string;
  tip: string;
}

const ACK_KEY = "tokyo_notice_ack_v1";
const SUPPRESS_MS = 60 * 60 * 1000;

export function AnnouncementPopup({
  items,
  copy,
}: {
  items: { id: number; title: string; body: string }[];
  copy: NoticePopupCopy;
}) {
  const [open, setOpen] = useState(false);

  const signature = items.map((item) => `${item.id}:${item.body.length}`).join("|");

  useEffect(() => {
    if (items.length === 0) return;
    // 源站语义：同签名 + 未过期（1 小时）才抑制；内容一改就重新弹。
    try {
      const stored = JSON.parse(localStorage.getItem(ACK_KEY) ?? "null") as
        | { signature: string; expiresAt: number }
        | null;
      const suppressed = Boolean(
        stored && stored.signature === signature && Number(stored.expiresAt) > Date.now(),
      );
      if (!suppressed) setOpen(true);
    } catch {
      // 隐私模式下 localStorage 会抛。弹一次总比崩掉好。
      setOpen(true);
    }
    // 导航「公告」按钮随时可再打开（tokyo-notice-trigger 同款交互）。
    const reopen = () => setOpen(true);
    window.addEventListener("tokyo:open-notice", reopen);
    return () => window.removeEventListener("tokyo:open-notice", reopen);
  }, [signature, items.length]);

  function confirmRead() {
    setOpen(false);
    try {
      localStorage.setItem(
        ACK_KEY,
        JSON.stringify({ signature, expiresAt: Date.now() + SUPPRESS_MS }),
      );
    } catch {
      /* 记不住就下次再弹，不影响功能 */
    }
  }

  if (!open || items.length === 0) return null;

  return (
    <div className="tokyo-notice-layer" role="dialog" aria-modal="true" aria-label={copy.title}>
      <button type="button" className="tokyo-notice-shade" aria-label="Close" onClick={() => setOpen(false)} />
      <div className="tokyo-notice-modal">
        <div className="tokyo-notice-modal-head">
          <span className="tokyo-notice-kicker">Notice</span>
          <h3 className="tokyo-notice-title">
            <i className="fa-duotone fa-regular fa-megaphone" aria-hidden />
            <span>{copy.title}</span>
          </h3>
        </div>
        <div className="tokyo-notice-popup-inner">
          {items.map((item) => (
            <section key={item.id}>
              <div className="rte" dangerouslySetInnerHTML={{ __html: item.body }} />
            </section>
          ))}
        </div>
        <div className="tokyo-notice-actions">
          <button
            type="button"
            className="tokyo-button tokyo-button-light tokyo-notice-cancel"
            onClick={() => setOpen(false)}
          >
            <i className="fa-duotone fa-regular fa-xmark" aria-hidden />
            <span>{copy.cancel}</span>
          </button>
          <button
            type="button"
            className="tokyo-button tokyo-button-dark tokyo-notice-confirm"
            onClick={confirmRead}
          >
            <i className="fa-duotone fa-regular fa-check" aria-hidden />
            <span>{copy.confirm}</span>
          </button>
        </div>
        <p className="tokyo-notice-tip">{copy.tip}</p>
      </div>
    </div>
  );
}
