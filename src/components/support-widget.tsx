"use client";

/**
 * 在线客服浮窗 —— 源站 online-service 挂件的同款形态：
 * 右下角耳机按钮 → 可展开的 iframe 客服窗口，可收起、可新开标签。
 *
 * 地址没配时整个组件不渲染，不留死按钮。不引入第三方 chat SDK。
 */

import { useState } from "react";

const COPY = {
  en: {
    launcher: "Support",
    close: "Collapse",
    openInNewTab: "Open in new window",
    title: "Live support",
  },
  "zh-CN": {
    launcher: "在线客服",
    close: "收起在线客服",
    openInNewTab: "在新窗口打开",
    title: "在线客服",
  },
} as const;

export function SupportWidget({
  url,
  locale,
}: {
  url: string;
  locale: string;
}) {
  const [open, setOpen] = useState(false);
  const copy = locale === "zh-CN" ? COPY["zh-CN"] : COPY.en;

  return (
    <section className={`online-service${open ? " is-open" : " is-closed"}`} id="online-service">
      <button
        className="online-service-launcher"
        type="button"
        aria-label={copy.launcher}
        title={copy.launcher}
        onClick={() => setOpen((value) => !value)}
      >
        <i className="fa-duotone fa-regular fa-headset" aria-hidden />
      </button>
      <div className="online-service-window" role="dialog" aria-label={copy.title}>
        <div className="online-service-titlebar">
          <span>
            <i className="fa-duotone fa-regular fa-headset" aria-hidden /> {copy.title}
          </span>
          <div className="online-service-actions">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="online-service-popout"
              title={copy.openInNewTab}
              aria-label={copy.openInNewTab}
            >
              <i className="fa-duotone fa-regular fa-arrow-up-right-from-square" aria-hidden />
            </a>
            <button
              type="button"
              className="online-service-close"
              aria-label={copy.close}
              title={copy.close}
              onClick={() => setOpen(false)}
            >
              <i className="fa-duotone fa-regular fa-minus" aria-hidden />
            </button>
          </div>
        </div>
        <iframe
          className="online-service-frame"
          title={copy.title}
          src={open ? url : undefined}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
}
