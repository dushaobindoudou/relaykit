import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { StoreHeader } from "@/components/storefront";
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

  const { context, locale, t, user, popups } = loaded.page;
  const list = await context.db
    .select()
    .from(articles)
    .where(eq(articles.published, true))
    .orderBy(desc(articles.pinned), articles.sort);

  const fmt = (value: Date | string) =>
    new Date(value).toISOString().slice(0, 16).replace("T", " ");

  return (
    <>
      <StoreHeader
        storeName={context.config.store.name}
        locale={locale}
        t={t}
        user={userSummary(user)}
        supportUrl={context.config.store.supportUrl ?? null}
        popups={popups}
      />

      {/* 源站帮助中心（help-center-page）同款：面包屑 + hero + 文章行 */}
      <main className="help-center-page">
        <div className="help-center-shell">
          <div className="help-center-breadcrumb">
            <Link href="/">{t.help.home}</Link>
            <span>/</span>
            <strong>{t.help.title}</strong>
          </div>

          <section className="help-center-hero">
            <div>
              <span className="help-eyebrow">HELP CENTER</span>
              <h1>{t.help.title}</h1>
              <p>{t.help.intro}</p>
            </div>
            <i className="fa-duotone fa-regular fa-circle-question" aria-hidden />
          </section>

          <section className="help-article-list">
            {list.length === 0 ? (
              <div className="help-empty">{t.help.empty}</div>
            ) : (
              list.map((article) => (
                <article
                  className={`help-article-row${article.pinned ? " is-top" : ""}`}
                  key={article.slug}
                >
                  <div className="help-article-copy">
                    <div className="help-article-title-line">
                      <h2>{article.title}</h2>
                      {article.pinned && (
                        <span className="help-top-badge">{t.help.pinned}</span>
                      )}
                    </div>
                    {article.summary && <p>{article.summary}</p>}
                    <time>{fmt(article.updatedAt)}</time>
                  </div>
                  <Link className="help-read-button" href={`/help/${article.slug}`}>
                    {t.help.readArticle}{" "}
                    <i className="fa-duotone fa-regular fa-arrow-right" aria-hidden />
                  </Link>
                </article>
              ))
            )}
          </section>
        </div>
      </main>
    </>
  );
}
