"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { LOCALES, LOCALE_LABEL, type Locale } from "@/i18n/dictionary";

/**
 * 语言切换。
 *
 * 写 cookie 后 router.refresh() 让服务端组件用新语言重渲染 ——
 * 文案全部在服务端，不需要把字典打进客户端 bundle。
 */
export function LocaleSwitch({ current }: { current: Locale }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    if (next === current) return;
    // react-compiler 把全局 document 的属性写误判为非法变更；cookie 写是合法 DOM API。
    // eslint-disable-next-line react-hooks/immutability
    document.cookie = `buyrelay_lang=${next}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className="tokyo-locale-switch" data-pending={pending}>
      {LOCALES.map((locale, index) => (
        <span key={locale} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden>/</span>}
          <button
            type="button"
            onClick={() => choose(locale)}
            aria-current={locale === current}
            className={locale === current ? "is-current" : ""}
          >
            {LOCALE_LABEL[locale]}
          </button>
        </span>
      ))}
    </div>
  );
}
