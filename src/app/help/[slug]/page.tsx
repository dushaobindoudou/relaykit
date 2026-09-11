import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { PageFrame } from "@/components/page-frame";
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

  const { context, locale, t, user, banner } = loaded.page;

  return (
    <PageFrame
      storeName={context.config.store.name}
      currency={context.config.store.currency}
      supportEmail={context.config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
      width="max-w-2xl"
    >
      <nav className="text-[13px] text-[var(--text-faint)]">
        <Link href="/help" className="hover:text-[var(--text)]">
          {t.help.back}
        </Link>
      </nav>

      <h1 className="mt-5 text-[28px] font-semibold leading-[1.2] tracking-[-0.015em]">
        {article.title}
      </h1>

      {/* 文章正文由店主在后台撰写，是站内唯一不受上游限制的可索引内容。 */}
      <div
        className="rte mt-6 text-[15px] leading-relaxed"
        dangerouslySetInnerHTML={{ __html: article.body }}
      />
    </PageFrame>
  );
}
