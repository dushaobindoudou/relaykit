/**
 * 店面首页。
 *
 * 服务端渲染：商品数据来自本地快照表，不在渲染路径上打上游 —— 页面速度
 * 不该取决于别人站点的响应时间。同时这也让页面可被搜索引擎正常抓取。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { listSellable } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

/** 配置没通过时的兜底页：直接把问题和修法写在页面上。 */
function SetupNeeded({ error }: { error: string }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <p className="text-sm font-medium text-amber-600">Setup required</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">
        配置尚未就绪
      </h1>
      <pre className="mt-6 overflow-x-auto rounded-xl bg-neutral-900 p-5 text-sm leading-relaxed text-neutral-100">
        {error}
      </pre>
      <p className="mt-6 text-sm text-neutral-600">
        改好配置后重新部署即可。详细诊断见{" "}
        <a className="underline underline-offset-4" href="/api/health">
          /api/health
        </a>
        。
      </p>
    </main>
  );
}

export default async function Home() {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);

  if (!result.ok || !result.context) {
    return <SetupNeeded error={result.error ?? "未知错误"} />;
  }

  const { config } = result.context;
  const items = await listSellable(result.context);
  const notReady = config.payments.chains
    .filter((chain) => chain.enabled && isPlaceholderAddress(chain.address))
    .map((chain) => chain.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header>
        <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">
          {config.store.name}
        </h1>
        <p className="mt-3 text-neutral-500">
          Instant delivery · Paid in {config.store.currency}
        </p>
      </header>

      {notReady.length > 0 && (
        // 演示模式的显眼提示。宁可难看也要让人知道这站现在收不了钱 ——
        // 静默地"看起来能用"是最坏的情况。
        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong className="font-semibold">演示模式：</strong>
          {notReady.join("、")} 的收款地址尚未配置，下单会被拒绝。
          执行 <code className="rounded bg-amber-100 px-1">wrangler secret put</code>{" "}
          设置地址后重新部署。
        </div>
      )}

      {items.length === 0 ? (
        <div className="mt-12 rounded-xl border border-neutral-200 p-10 text-center">
          <p className="text-neutral-900">暂无可售商品</p>
          <p className="mt-2 text-sm text-neutral-500">
            商品目录每 15 分钟自动同步一次；也可以手动触发{" "}
            <code className="rounded bg-neutral-100 px-1">POST /api/admin/sync</code>。
            若同步后仍为空，多半是毛利低于下限或上游未开放对接，见{" "}
            <a className="underline underline-offset-4" href="/api/health">
              /api/health
            </a>
            。
          </p>
        </div>
      ) : (
        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {items.map((item) => (
            <li
              key={`${item.supplierId}:${item.code}:${item.race}`}
              className="rounded-2xl border border-neutral-200 p-6 transition hover:border-neutral-300"
            >
              <h2 className="font-medium text-neutral-900">{item.name}</h2>
              {item.race !== "" && (
                <p className="mt-1 text-sm text-neutral-500">{item.race}</p>
              )}
              <p className="mt-4 text-2xl font-semibold tabular-nums text-neutral-900">
                {item.price}
                <span className="ml-1 text-sm font-normal text-neutral-500">
                  {config.store.currency}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-20 border-t border-neutral-200 pt-8 text-sm text-neutral-400">
        Powered by{" "}
        <a
          className="underline underline-offset-4"
          href="https://github.com/dushaobindoudou/relaykit"
        >
          RelayKit
        </a>
      </footer>
    </main>
  );
}
