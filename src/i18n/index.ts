/**
 * 语言解析。
 *
 * 优先级：cookie（用户显式切换） > 配置里的 store.locale（店主的默认）。
 * 刻意**不读 Accept-Language**：店主配了中文站却给英语浏览器自动切英文，
 * 是在替店主做他没要求的决定；显式切换才作数。
 */

import { cookies } from "next/headers";

import { DICTS, LOCALES, type Dict, type Locale } from "@/i18n/dictionary";

export const LOCALE_COOKIE = "relaykit_lang";

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as string[]).includes(value);
}

export async function resolveLocale(fallback: string): Promise<Locale> {
  const store = await cookies();
  const chosen = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return isLocale(fallback) ? fallback : "en";
}

export function dict(locale: Locale): Dict {
  return DICTS[locale];
}

/** 一次拿到语言与字典，页面里最常用的形式。 */
export async function getI18n(fallback: string): Promise<{ locale: Locale; t: Dict }> {
  const locale = await resolveLocale(fallback);
  return { locale, t: dict(locale) };
}
