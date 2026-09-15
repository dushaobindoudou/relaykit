"use client";

/**
 * 在线客服挂件 —— 用户决策：直接跳转到（源站的）客服页面，不做内嵌。
 *
 * 右下角耳机按钮 = 一个新标签链接。地址没配时整个组件不渲染。
 */

const COPY = {
  en: { launcher: "Support" },
  "zh-CN": { launcher: "在线客服" },
} as const;

export function SupportWidget({
  url,
  locale,
}: {
  url: string;
  locale: string;
}) {
  const copy = locale === "zh-CN" ? COPY["zh-CN"] : COPY.en;

  return (
    <section className="online-service is-open" id="online-service">
      <a
        className="online-service-launcher"
        href={url}
        target="_blank"
        rel="noopener"
        aria-label={copy.launcher}
        title={copy.launcher}
      >
        <i className="fa-duotone fa-regular fa-headset" aria-hidden />
      </a>
    </section>
  );
}
