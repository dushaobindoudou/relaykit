/**
 * 订单页 —— 源站收银台（cashier）的 1:1 移植。
 *
 * 这是客户付完钱后盯着看的页面，信任感全靠它和源站「同一家店」的观感：
 * 警告面板（到账必须完全一致）→ 三步骤 → 金额/地址（一键复制）→
 * 二维码 + 倒计时 → 等待确认状态点。
 *
 * 服务端只渲染外壳与静态信息（二维码 SVG 也在服务端生成）；
 * 状态轮询、倒计时、卡密展示在客户端组件里。
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { StoreHeader } from "@/components/storefront";
import { OrderView } from "@/components/order-view";
import { getOrder } from "@/orders/service";
import { convertAmount } from "@/pricing/engine";
import { fxFromConfig } from "@/catalog/sync";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";

// 订单页永远不进搜索引擎 —— 它包含卡密。
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

/** 链的展示名：源站用首字母大写的网络名（Polygon / BSC）。 */
function chainLabel(chainId: string): string {
  if (chainId === "bsc") return "BSC";
  return chainId.charAt(0).toUpperCase() + chainId.slice(1);
}

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) notFound();

  const { context, locale, t, user } = loaded.page;
  const order = await getOrder(context, id);
  if (!order) notFound();

  const { config } = context;
  const isChain = order.payMethod === "chain";
  const isManual = order.payMethod !== "chain" && order.payMethod !== "balance";

  // 收款地址 → 服务端生成二维码 SVG（客户端零依赖）。
  const qrSvg = isChain && order.payAddress
    ? await QRCode.toString(order.payAddress, {
        type: "svg",
        margin: 0,
        color: { dark: "#1c2024", light: "#ffffff" },
      })
    : null;

  const label = chainLabel(order.chainId ?? "");
  const o = t.order;
  // t.order 里新加了函数型文案（deadline/step1/...），整包传客户端组件
  // 会被 RSC 序列化拒收 —— 先剥掉函数，只留纯字符串键。
  const orderCopy: Record<string, string> = {};
  for (const [key, value] of Object.entries(t.order)) {
    if (typeof value === "string") orderCopy[key] = value;
  }
  // 函数型文案必须在服务端求值 —— 函数不能跨 RSC 边界序列化。
  const checkout = {
    title: o.checkoutTitle,
    sub: o.checkoutSub,
    channelLabel: o.channelLabel,
    networkLabel: o.networkLabel,
    warningLead: o.warningLead,
    warningStrong: o.warningStrong,
    warningNote1: o.warningNote1,
    warningNote2: o.warningNote2,
    deadline: o.deadline(config.payments.windowMinutes),
    deadlineSub: o.deadlineSub,
    step1: o.step1(label),
    step2: o.step2,
    step3: o.step3(label),
    quickCopy: o.quickCopy,
    quickCopyHint: o.quickCopyHint,
    amountLabel: o.amountLabel,
    addressLabel: o.addressLabel(label),
    waitingConfirm: o.waitingConfirm,
    unitH: o.unitH,
    unitM: o.unitM,
    unitS: o.unitS,
    manualChannelLabel: o.manualChannelLabel,
  };

  return (
    <>
      <StoreHeader storeName={config.store.name} locale={locale} t={t} user={userSummary(user)} />

      {/* 服务端只下发非敏感字段。卡密要凭口令另取，绝不在首屏 HTML 里。 */}
      <OrderView
        copy={orderCopy as never}
        statusCopy={t.status}
        checkout={checkout}
        orderId={order.id}
        status={order.status}
        productName={order.productName}
        race={order.race}
        quantity={order.quantity}
        currency={order.currency}
        payAmount={order.payAmount ?? ""}
        payAddress={order.payAddress ?? ""}
        chainId={order.chainId ?? ""}
        chainLabel={label}
        qrSvg={qrSvg}
        windowMinutes={config.payments.windowMinutes}
        payWindowEndsAt={order.payWindowEndsAt ?? ""}
        manualPayment={
          isManual
            ? (() => {
                const channel = config.payments.manual?.channels.find(
                  (item) => item.id === order.payMethod,
                );
                if (!channel) return null;
                // 人工对账按订单号核对，显示给客户转的是本币金额（¥）。
                return {
                  channel: channel.label,
                  account: channel.account,
                  qrImage: channel.qrImage ?? null,
                  instructions: channel.instructions ?? null,
                  amountCny: convertAmount(
                    order.priceTotal,
                    fxFromConfig(context).rates,
                    config.store.currency,
                    "CNY",
                  ),
                };
              })()
            : null
        }
        createdAt={order.createdAt}
        reservation={order.reservation}
        /* 退到余额的资格：预订中 + 登录 + 本人的单。匿名预订走客服。 */
        canRefundReservation={order.status === "reserved" && user !== null && order.userId === user.id}
      />
    </>
  );
}
