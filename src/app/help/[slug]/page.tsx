import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { StoreHeader } from "@/components/storefront";
import { articles } from "@/db/schema";
import { buildContext, type Bindings } from "@/runtime/context";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";

async function findArticle(slug: string) {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) return null;

  const rows = await result.context.db
    .select()
    .from(articles)
    .where(and(eq(articles.slug, slug), eq(articles.published, true)))
    .limit(1);
  return rows[0] ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await findArticle(slug);
  if (!article) return { title: "Not found", robots: { index: false } };

  return {
    title: article.title,
    ...(article.summary ? { description: article.summary } : {}),
    alternates: { canonical: `/help/${article.slug}` },
    openGraph: {
      title: article.title,
      ...(article.summary ? { description: article.summary } : {}),
      type: "article",
    },
  };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) notFound();

  const article = await findArticle(slug);
  if (!article) notFound();

  const { context, locale, t, user, popups } = loaded.page;

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

      {/* 源站文章详情（help-article-detail）同款 */}
      <main className="help-center-page">
        <div className="help-center-shell">
          <div className="help-center-breadcrumb">
            <Link href="/">{t.help.home}</Link>
            <span>/</span>
            <Link href="/help">{t.help.title}</Link>
            <span>/</span>
            <strong>{article.title}</strong>
          </div>

          <article className="help-article-detail">
            <header>
              <h1>{article.title}</h1>
              <div>
                {new Date(article.updatedAt).toISOString().slice(0, 16).replace("T", " ")}
              </div>
            </header>
            {/* 文章正文由店主在后台撰写，是站内唯一不受上游限制的可索引内容。 */}
            <div
              className="help-article-content rte"
              dangerouslySetInnerHTML={{ __html: article.body }}
            />
          </article>
        </div>
      </main>
    </>
  );
}
