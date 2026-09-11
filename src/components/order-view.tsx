"use client";

/**
 * 订单状态视图。
 *
 * 设计上只服务一个问题：「我的东西什么时候到」。
 * 所以付款指引是整页最大的元素，其余信息一律收进次要层级。
 *
 * 金额与地址用等宽字体并提供一键复制 —— 手抄一个 42 位地址或一个
 * 带四位小数的金额是真实的出错来源，而抄错金额会导致订单匹配不上。
 */

import { useEffect, useState } from "react";

import { Badge, Row } from "@/components/site-chrome";
import { PaymentInstructions } from "@/components/payment-instructions";

type Status =
  | "draft"
  | "awaiting_payment"
  | "paid"
  | "procuring"
  | "fulfilled"
  | "procurement_failed"
  | "refunded"
  | "needs_review"
  | "expired";

/**
 * 状态 → 视觉色调。
 *
 * 文案由服务端按语言传入（status/order 两组），这里只决定颜色 ——
 * 颜色是与语言无关的，不该重复翻译。
 */
const TONE_BY_STATUS: Record<Status, "ok" | "warn" | "danger" | "accent" | "neutral"> = {
  draft: "neutral",
  awaiting_payment: "accent",
  paid: "ok",
  procuring: "ok",
  fulfilled: "ok",
  procurement_failed: "danger",
  refunded: "neutral",
  needs_review: "warn",
  expired: "neutral",
};

export type StatusCopy = Record<Status, { label: string; help: string }>;

export interface OrderCopy {
  orderNumber: string;
  sendExactly: string;
  left: string;
  address: string;
  amount: string;
  copy: string;
  copied: string;
  yourCode: string;
  item: string;
  quantity: string;
  total: string;
  placed: string;
  bookmark: string;
  lookupLink: string;
  bookmarkTail: string;
  enterPassword: string;
  openLookup: string;
  exactDecimals: string;
}

export function OrderView(props: {
  copy: OrderCopy;
  statusCopy: StatusCopy;
  orderId: string;
  status: string;
  productName: string;
  race: string;
  quantity: number;
  currency: string;
  payAmount: string;
  payAddress: string;
  chainId: string;
  payWindowEndsAt: string;
  createdAt: string;
}) {
  const [status, setStatus] = useState(props.status as Status);
  const [secret, setSecret] = useState<string | null>(null);
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);

  // 口令：从 URL 取一次就换进 sessionStorage 并清掉地址栏，
  // 免得客户把带口令的链接截图发出去。
  const [password, setPassword] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("k");
    const key = `relaykit:order:${props.orderId}`;

    if (fromUrl) {
      sessionStorage.setItem(key, fromUrl);
      url.searchParams.delete("k");
      window.history.replaceState({}, "", url.toString());
      setPassword(fromUrl);
    } else {
      setPassword(sessionStorage.getItem(key));
    }
  }, [props.orderId]);

  const settled =
    status === "fulfilled" ||
    status === "expired" ||
    status === "refunded" ||
    status === "procurement_failed";

  useEffect(() => {
    if (settled || !password) return;

    let cancelled = false;
    // 3 秒一轮。链上确认本来就要几十秒到几分钟，更密的轮询只是白费请求。
    const poll = async () => {
      const response = await fetch(
        `/api/orders/${props.orderId}?k=${encodeURIComponent(password)}`,
        { cache: "no-store" },
      );
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as {
        status: Status;
        secret: string | null;
        leaveMessage: string | null;
      };
      if (cancelled) return;
      setStatus(data.status);
      setSecret(data.secret);
      setLeaveMessage(data.leaveMessage);
    };

    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [props.orderId, password, settled]);

  const copy = props.copy;
  const view = props.statusCopy[status] ?? props.statusCopy.draft;
  const tone = TONE_BY_STATUS[status] ?? "neutral";

  return (
    <div className="mx-auto max-w-xl">
      <div className="flex items-center justify-between gap-4">
        <p className="numeric text-[13px] text-[var(--text-faint)]">
          {copy.orderNumber} {props.orderId}
        </p>
        <Badge tone={tone}>{view.label}</Badge>
      </div>

      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.015em]">
        {props.productName}
      </h1>
      <p className="mt-2 text-[14px] text-[var(--text-muted)]">{view.help}</p>

      {status === "awaiting_payment" && (
        <div className="mt-7">
          <PaymentInstructions
            amount={props.payAmount}
            address={props.payAddress}
            chainId={props.chainId}
            currency={props.currency}
            endsAt={props.payWindowEndsAt}
            copy={copy}
          />
        </div>
      )}

      {status === "fulfilled" && secret && (
        <section className="mt-8 rounded-[var(--radius-card)] border border-[var(--ok)] bg-[var(--ok-wash)] p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--ok)]">
            {copy.yourCode}
          </h2>
          <pre className="numeric mt-3 whitespace-pre-wrap break-all rounded-[var(--radius-card)] bg-[var(--bg-raised)] p-4 text-[14px] leading-relaxed">
            {secret}
          </pre>
          {leaveMessage && (
            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-muted)]">
              {leaveMessage}
            </p>
          )}
        </section>
      )}

      {status === "fulfilled" && !secret && (
        <section className="mt-8 rounded-[var(--radius-card)] border border-[var(--line)] p-5">
          <p className="text-[14px]">
            {copy.enterPassword}
          </p>
          <a
            href="/lookup"
            className="mt-3 inline-block text-[14px] text-[var(--accent)] underline underline-offset-4"
          >
            {copy.openLookup}
          </a>
        </section>
      )}

      <dl className="mt-8 border-t border-[var(--line)] pt-4">
        <Row label={copy.item}>
          {props.productName}
          {props.race ? ` · ${props.race}` : ""}
        </Row>
        <Row label={copy.quantity} mono>
          {props.quantity}
        </Row>
        <Row label={copy.total} mono>
          {props.payAmount} {props.currency}
        </Row>
        <Row label={copy.placed} mono>
          {new Date(props.createdAt).toISOString().slice(0, 16).replace("T", " ")}
        </Row>
      </dl>

      <p className="mt-6 text-[12px] leading-relaxed text-[var(--text-faint)]">
        {copy.bookmark}{" "}
        <a href="/lookup" className="text-[var(--accent)] underline underline-offset-4">
          {copy.lookupLink}
        </a>{" "}
        {copy.bookmarkTail}
      </p>
    </div>
  );
}
