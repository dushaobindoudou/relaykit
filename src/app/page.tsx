import Link from "next/link";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { listCatalog } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { Badge, Notice, Page, SiteFooter } from "@/components/site-chrome";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

function SetupNeeded({ error }: { error: string }) {
  return (
    <Page>
      <h1 className="text-2xl font-semibold tracking-tight">Setup required</h1>
      <p className="mt-2 text-[14px] text-[var(--text-muted)]">
        店铺配置尚未就绪，客户暂时看不到商品。
      </p>
      <pre className="mt-6 overflow-x-auto rounded-[var(--radius-card)] bg-[var(--bg-sunken)] p-5 text-[13px] leading-relaxed">
        {error}
      </pre>
      <p className="mt-5 text-[13px] text-[var(--text-muted)]">
        完整诊断见{" "}
        <Link href="/api/health" className="text-[var(--accent)] underline underline-offset-4">
          /api/health
        </Link>
      </p>
    </Page>
  );
}

export default async function Home() {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);

  if (!result.ok || !result.context) {
    return <SetupNeeded error={result.error ?? "未知错误"} />;
  }

  const { config } = result.context;
  const entries = await listCatalog(result.context);
  const unpayable = config.payments.chains
    .filter((chain) => chain.enabled && isPlaceholderAddress(chain.address))
    .map((chain) => chain.id);
  const canSell = config.payments.chains.some(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );

  return (
    <>
      <Page>
        {/* 标题区刻意克制：客户是来买东西的，不是来读品牌宣言的。
            主视觉就是商品清单本身。 */}
        <div className="max-w-xl">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[40px]">
            {config.store.name}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--text-muted)]">
            Pay in {config.store.currency}. Your code is delivered automatically once the
            payment confirms on-chain.
          </p>
        </div>

        {!canSell && (
          <div className="mt-8">
            <Notice title="Demo mode">
              {unpayable.join(", ")} 的收款地址尚未配置，下单会被拒绝。设置后重新部署即可开售。
            </Notice>
          </div>
        )}

        {entries.length === 0 ? (
          <div className="mt-12 border-t border-[var(--line)] pt-12">
            <p className="text-[15px]">No products listed yet.</p>
            <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-[var(--text-muted)]">
              目录每 15 分钟自动同步。若同步后仍为空，多半是毛利低于下限、上游未开放对接，
              或汇率已过期。逐条原因见{" "}
              <Link href="/api/health" className="text-[var(--accent)] underline underline-offset-4">
                /api/health
              </Link>
              。
            </p>
          </div>
        ) : (
          // 发丝线分隔的清单，而不是卡片网格。价格右对齐、等宽，方便竖着扫读比价 ——
          // 这是买家在列表页真正做的事。
          <ul className="mt-10 border-t border-[var(--line)]">
            {entries.map((entry) => (
              <li key={`${entry.supplierId}:${entry.code}`}>
                <Link
                  href={`/p/${entry.supplierId}/${encodeURIComponent(entry.code)}`}
                  className="group flex items-center justify-between gap-6 border-b border-[var(--line)] py-5 transition-colors hover:bg-[var(--bg-sunken)]"
                >
                  <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-medium group-hover:text-[var(--accent)]">
                      {entry.name}
                    </h2>
                    <p className="mt-1 text-[13px] text-[var(--text-faint)]">
                      {entry.variants.length > 1
                        ? `${entry.variants.length} options`
                        : "Instant delivery"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="numeric text-[17px] font-semibold">
                      {entry.variants.length > 1 ? (
                        <span className="mr-1 font-sans text-[12px] font-normal text-[var(--text-faint)]">
                          from
                        </span>
                      ) : null}
                      {entry.fromPrice}
                    </p>
                    <p className="text-[12px] text-[var(--text-faint)]">
                      {config.store.currency}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {entries.length > 0 && (
          <div className="mt-10 flex flex-wrap gap-2">
            <Badge tone="ok">Automatic delivery</Badge>
            <Badge>No account needed</Badge>
            <Badge>
              {config.payments.chains
                .filter((chain) => chain.enabled && !isPlaceholderAddress(chain.address))
                .map((chain) => chain.id.toUpperCase())
                .join(" / ") || "Payment not configured"}
            </Badge>
          </div>
        )}
      </Page>
      <SiteFooter supportEmail={config.store.supportEmail ?? null} />
    </>
  );
}
