/**
 * 订单页：付款指引 + 状态 + 卡密。
 *
 * 这是客户付完钱后盯着看的页面，所以它要回答的只有一个问题：
 * **「我的东西到底什么时候到？」** 一切不服务于这个问题的内容都不该在这里。
 *
 * 服务端只渲染外壳与静态信息；状态轮询与卡密展示在客户端组件里，
 * 因为需要口令校验后才拉取。
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/page-frame";
import { OrderView } from "@/components/order-view";
import { getOrder } from "@/orders/service";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";

// 订单页永远不进搜索引擎 —— 它包含卡密。
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) notFound();

  const { context, locale, t, user, banner } = loaded.page;
  const order = await getOrder(context, id);
  if (!order) notFound();

  const { config } = context;

  return (
    <PageFrame
      storeName={config.store.name}
      currency={config.store.currency}
      supportEmail={config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
      width="max-w-xl"
    >
      {/* 服务端只下发非敏感字段。卡密要凭口令另取，绝不在首屏 HTML 里。 */}
      <OrderView
        copy={t.order}
        statusCopy={t.status}
        orderId={order.id}
        status={order.status}
        productName={order.productName}
        race={order.race}
        quantity={order.quantity}
        currency={order.currency}
        payAmount={order.payAmount ?? ""}
        payAddress={order.payAddress ?? ""}
        chainId={order.chainId ?? ""}
        payWindowEndsAt={order.payWindowEndsAt ?? ""}
        createdAt={order.createdAt}
      />
    </PageFrame>
  );
}
