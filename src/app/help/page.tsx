import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { PageFrame } from "@/components/page-frame";
import { articles } from "@/db/schema";
import { loadPage, userSummary } from "@/runtime/page-context";
import { getStoreMeta } from "@/runtime/store-meta";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStoreMeta();
  return {
    title: "Help center",
    description: `Guides and payment help for ${store.name}.`,
    alternates: { canonical: "/help" },
  };
}

export default async function HelpIndex() {
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) return null;

  const { context, locale, t, user, banner } = loaded.page;
  const list = await context.db
    .select()
    .from(articles)
    .where(eq(articles.published, true))
    .orderBy(desc(articles.pinned), articles.sort);

  return (
    <PageFrame
      storeName={context.config.store.name}
      currency={context.config.store.currency}
      supportEmail={context.config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
    >
      <h1 className="text-[26px] font-semibold tracking-[-0.015em]">{t.help.title}</h1>
      <p className="mt-2 text-[14px] text-[var(--text-muted)]">{t.help.intro}</p>

      {list.length === 0 ? (
        <p className="mt-8 text-[14px] text-[var(--text-muted)]">{t.help.empty}</p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--line)] border-y border-[var(--line)]">
          {list.map((article) => (
            <li key={article.slug}>
              <Link href={`/help/${article.slug}`} className="block py-5 hover:opacity-70">
                <h2 className="text-[16px] font-medium">{article.title}</h2>
                {article.summary && (
                  <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
                    {article.summary}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}
