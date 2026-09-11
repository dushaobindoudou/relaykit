/**
 * 页面级上下文加载。
 *
 * 几乎每个店面页都要：配置 → 语言 → 当前登录用户 → 分类树 → 公告。
 * 抽成一处，避免每个页面重复五段样板，也保证「未登录时不去查用户」
 * 这类细节只写一次。
 */

import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { and, eq, sql } from "drizzle-orm";

import { listCategories } from "@/catalog/sync";
import { resolveSession, SESSION_COOKIE } from "@/accounts/auth";
import { announcements, type Announcement, type Category, type User } from "@/db/schema";
import { getI18n } from "@/i18n";
import type { Dict, Locale } from "@/i18n/dictionary";
import { buildContext, type Bindings, type RelayKitContext } from "@/runtime/context";

export interface PageContext {
  context: RelayKitContext;
  locale: Locale;
  t: Dict;
  user: User | null;
  categories: Category[];
  /** 顶部通栏公告（取排序最前的一条）。 */
  banner: Announcement | null;
  /** 需要弹窗的公告。 */
  popups: Announcement[];
}

export type PageLoad =
  | { ok: true; page: PageContext }
  | { ok: false; error: string; locale: Locale; t: Dict };

export async function loadPage(options: { categories?: boolean } = {}): Promise<PageLoad> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);

  if (!result.ok || !result.context) {
    const fallback = await getI18n("en");
    return {
      ok: false,
      error: result.error ?? "unknown",
      locale: fallback.locale,
      t: fallback.t,
    };
  }

  const context = result.context;
  const { locale, t } = await getI18n(context.config.store.locale);

  const cookieStore = await cookies();
  const user = await resolveSession(context, cookieStore.get(SESSION_COOKIE)?.value);

  const [categories, active] = await Promise.all([
    options.categories === false
      ? Promise.resolve([] as Category[])
      : listCategories(context),
    context.db
      .select()
      .from(announcements)
      .where(eq(announcements.active, true))
      .orderBy(sql`${announcements.sort} asc`),
  ]);

  return {
    ok: true,
    page: {
      context,
      locale,
      t,
      user,
      categories,
      banner: active.find((item) => item.bannerText) ?? null,
      popups: active.filter((item) => item.popup),
    },
  };
}

/** 头部要展示的用户摘要。不把整个 User 传进客户端组件。 */
export function userSummary(user: User | null): { email: string; balance: string } | null {
  return user ? { email: user.email, balance: user.balance } : null;
}

export { and, eq };
