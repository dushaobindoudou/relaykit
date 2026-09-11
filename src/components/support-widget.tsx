"use client";

/**
 * 在线客服浮窗 —— 全站右下角。
 *
 * 对齐原站的行为：常驻一个入口按钮，点开是内嵌 iframe 的客服窗口，
 * 也能弹出成独立标签页。形态上学 Shopify 的做法（Dawn 的 chat 按钮是圆的、
 * 深色的、贴边的），不学原站把客服窗口做成可拖拽的桌面应用 ——
 * 那是「卡网」的视觉指纹，正是我们要摆脱的东西。
 *
 * 不引入第三方 chat SDK：客服地址由配置给（Crisp / Tawk / 自建页面），
 * 这里只负责壳。地址没配时整个组件不渲染，不留死按钮。
 */

import { useState } from "react";

const COPY = {
  en: {
    launcher: "Support",
    close: "Close",
    openInNewTab: "Open in new tab",
    title: "Live support",
  },
  "zh-CN": {
    launcher: "客服",
    close: "关闭",
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
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-50 flex h-[min(560px,calc(100dvh-8rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--bg)] shadow-[0_24px_64px_rgba(0,0,0,.18)] sm:right-6">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
            <p className="text-[13px] font-semibold">{copy.title}</p>
            <div className="flex items-center gap-1">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[var(--radius-card)] px-2 py-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {copy.openInNewTab}
              </a>
              <button
                type="button"
                aria-label={copy.close}
                onClick={() => setOpen(false)}
                className="h-8 w-8 rounded-full text-[16px] text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
          </div>
          <iframe
            src={url}
            title={copy.title}
            className="min-h-0 w-full flex-1 border-0 bg-[var(--bg)]"
          />
        </div>
      )}

      <button
        type="button"
        aria-label={copy.launcher}
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-5 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--bg-raised)] text-[var(--pop)] shadow-[0_10px_28px_rgba(0,0,0,.16)] transition-transform hover:scale-105 active:scale-95 sm:right-6"
      >
        {/* 耳机图标。不用图标库：一个 SVG 足够，省一个依赖。 */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
          <path d="M21 15a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 15a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
        </svg>
      </button>
    </>
  );
}
