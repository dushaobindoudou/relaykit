"use client";

/**
 * 订单视图 —— 源站收银台（cashier）的客户端半边。
 *
 * 外壳（checkout-page/checkout-shell/checkout-head）在服务端布局语义里
 * 由本组件整体输出，因为状态轮询会切换整个身体的形态：
 *   awaiting_payment → 警告面板 + 三步骤 + 金额/地址/二维码/倒计时
 *   fulfilled        → 卡密
 *   其余状态         → 状态说明 + 订单信息
 *
 * 倒计时与「一键复制」是源站收银台的两个信任锚点，原样保留。
 */

import { useEffect, useState } from "react";

type Status =
  | "draft"
  | "awaiting_payment"
  | "paid"
  | "reserved"
  | "procuring"
  | "fulfilled"
  | "procurement_failed"
  | "refunded"
  | "needs_review"
  | "expired";

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
  refundReservation: string;
  refunding: string;
  refundedToBalance: string;
  refundFailed: string;
  manualTitle: string;
  manualPending: string;
  manualAccount: string;
  manualAmount: string;
  manualReference: string;
}

/** 收银台文案：函数型字段已在服务端求值为字符串。 */
export interface CheckoutCopy {
  title: string;
  sub: string;
  channelLabel: string;
  networkLabel: string;
  warningLead: string;
  warningStrong: string;
  warningNote1: string;
  warningNote2: string;
  deadline: string;
  deadlineSub: string;
  step1: string;
  step2: string;
  step3: string;
  quickCopy: string;
  quickCopyHint: string;
  amountLabel: string;
  addressLabel: string;
  waitingConfirm: string;
  unitH: string;
  unitM: string;
  unitS: string;
  manualChannelLabel: string;
}

function useCountdown(endsAt: string): { h: string; m: string; s: string; expired: boolean } {
  const [remaining, setRemaining] = useState(() =>
    endsAt ? Math.max(0, new Date(endsAt).getTime() - Date.now()) : 0,
  );

  useEffect(() => {
    if (!endsAt) return;
    const tick = () => setRemaining(Math.max(0, new Date(endsAt).getTime() - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [endsAt]);

  const total = Math.floor(remaining / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    h: pad(Math.floor(total / 3600)),
    m: pad(Math.floor((total % 3600) / 60)),
    s: pad(total % 60),
    expired: remaining <= 0,
  };
}

export function OrderView(props: {
  copy: OrderCopy;
  statusCopy: StatusCopy;
  checkout: CheckoutCopy;
  orderId: string;
  status: string;
  productName: string;
  race: string;
  quantity: number;
  currency: string;
  /** 人民币参考价「≈ ¥xx.xx」；null 表示汇率不可用，不展示。 */
  payAmountCny: string | null;
  payAmount: string;
  payAddress: string;
  chainId: string;
  chainLabel: string;
  qrSvg: string | null;
  windowMinutes: number;
  payWindowEndsAt: string;
  createdAt: string;
  /** 预订单标记：影响等待补货提示与自助退款入口的展示。 */
  reservation?: boolean;
  /** 手动收款渠道（支付宝/微信转账）的展示信息；非转账单为 null。 */
  manualPayment?: {
    channel: string;
    account: string;
    qrImage: string | null;
    instructions: string | null;
    amountCny: string;
  } | null;
  /** 预订单可自助退到余额（登录 + 本人）。 */
  canRefundReservation?: boolean;
}) {
  const [status, setStatus] = useState(props.status as Status);
  const [secret, setSecret] = useState<string | null>(null);
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);
  const [refundState, setRefundState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [copied, setCopied] = useState<string | null>(null);

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

  /** 预订单自助退款。服务端已做资格判定，这里只管交互与展示结果。 */
  async function refundReservation() {
    if (refundState === "busy") return;
    setRefundState("busy");
    try {
      const response = await fetch(
        `/api/orders/${props.orderId}/refund-to-balance`,
        { method: "POST" },
      );
      const data = (await response.json()) as { ok: boolean };
      if (data.ok) {
        setRefundState("done");
        setStatus("refunded");
      } else {
        setRefundState("error");
      }
    } catch {
      setRefundState("error");
    }
  }

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
  const checkout = props.checkout;
  const manualPayment = props.manualPayment ?? null;
  const view = props.statusCopy[status] ?? props.statusCopy.draft;
  const isChainAwaiting = status === "awaiting_payment" && !manualPayment && props.payAmount;
  const timer = useCountdown(props.payWindowEndsAt);

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用（旧浏览器/权限）：静默失败，文字仍可手选。
    }
  }

  const dotClass =
    status === "fulfilled" || status === "paid" || status === "procuring"
      ? " is-paid"
      : status === "expired" || status === "refunded" || status === "procurement_failed"
        ? " is-expired"
        : "";

  return (
    <main className="checkout-page">
      <section className="checkout-shell" id="checkout">
        <header className="checkout-head">
          <div className="checkout-head-top">
            <div>
              <h1>{isChainAwaiting ? checkout.title : view.label}</h1>
              <p>
                {isChainAwaiting ? checkout.sub : view.help}
              </p>
            </div>
            {manualPayment ? (
              <span className="network-badge">{manualPayment.channel}</span>
            ) : (
              <span className="network-badge">{props.chainLabel || props.currency}</span>
            )}
          </div>
          <div className="order-meta">
            <div className="order-number">
              <b>{copy.orderNumber}</b>
              <span>{props.orderId}</span>
            </div>
            <div className="meta-line">
              <span>{checkout.channelLabel}</span>
              <span className="meta-pill">
                {manualPayment ? manualPayment.channel : props.chainId ? "USDT" : props.currency}
              </span>
              <span>{checkout.networkLabel}</span>
              <span className="meta-pill">{props.chainLabel || "—"}</span>
            </div>
          </div>
        </header>

        <div className="checkout-body">
          {/* —— 链上待支付：源站收银台主体 —— */}
          {isChainAwaiting && (
            <>
              <section className="warning-panel">
                <div className="warning-title">
                  <span className="warning-icon">!</span>
                  <span>{checkout.warningLead}</span>
                  <strong>{checkout.warningStrong}</strong>
                </div>
                <p className="warning-note">
                  {checkout.warningNote1}
                  <br />
                  {checkout.warningNote2}
                </p>
                <div className="divider" />
                <div className="deadline">{checkout.deadline}</div>
                <div className="deadline-sub">{checkout.deadlineSub}</div>
              </section>

              <section className="steps">
                <div className="step">
                  <span className="step-no">1</span>
                  <span>{checkout.step1}</span>
                </div>
                <div className="step">
                  <span className="step-no">2</span>
                  <span>{checkout.step2}</span>
                </div>
                <div className="step">
                  <span className="step-no">3</span>
                  <span>{checkout.step3}</span>
                </div>
              </section>

              <div className="quick-copy">
                <b>{checkout.quickCopy}</b>
                <span>{checkout.quickCopyHint}</span>
              </div>

              <section className="payment-box">
                <span className="amount-label">{checkout.amountLabel}</span>
                <button
                  type="button"
                  className="amount copyAmount"
                  style={{ all: "unset", cursor: "pointer" }}
                  onClick={() => copyText("amount", props.payAmount)}
                >
                  {props.payAmount} <span>{props.currency}</span>
                  {props.payAmountCny && (
                    <span className="amount-cny">{props.payAmountCny}</span>
                  )}
                </button>
                <div className="address-label">{checkout.addressLabel}</div>
                <button
                  type="button"
                  className="address-button copyAccount"
                  onClick={() => copyText("address", props.payAddress)}
                >
                  {props.payAddress}
                </button>
                <div className="payment-main">
                  <div className="qr-wrap">
                    {props.qrSvg && (
                      <div
                        role="img"
                        aria-label={`${checkout.addressLabel} QR`}
                        dangerouslySetInnerHTML={{ __html: props.qrSvg }}
                      />
                    )}
                  </div>
                  <div className="timer" aria-label="countdown">
                    <div className="timer-value">
                      <div className="time-unit">
                        <strong>{timer.h}</strong>
                        <span>{checkout.unitH}</span>
                      </div>
                      <i className="colon">:</i>
                      <div className="time-unit">
                        <strong>{timer.m}</strong>
                        <span>{checkout.unitM}</span>
                      </div>
                      <i className="colon">:</i>
                      <div className="time-unit">
                        <strong>{timer.s}</strong>
                        <span>{checkout.unitS}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="payment-status">
                  <span className={`status-dot${dotClass}`} />
                  <span>
                    {copied
                      ? copy.copied
                      : timer.expired
                        ? props.statusCopy.expired.label
                        : checkout.waitingConfirm}
                  </span>
                </div>
              </section>
            </>
          )}

          {/* —— 人工转账（支付宝/微信）：我们的差异通道，外壳同语言 —— */}
          {status === "awaiting_payment" && manualPayment && (
            <section className="manual-transfer-panel">
              <div className="warning-title">
                <span className="warning-icon">✓</span>
                <span>{copy.manualTitle} · {manualPayment.channel}</span>
              </div>
              <p className="warning-note" style={{ color: "#2f6b4f" }}>
                {copy.manualPending}
              </p>
              <div>
                <span className="amount-label">{copy.manualAmount}</span>
                <div className="amount">
                  ¥{manualPayment.amountCny} <span>CNY</span>
                </div>
              </div>
              <div>
                <div className="address-label">{copy.manualAccount}</div>
                <button
                  type="button"
                  className="address-button"
                  onClick={() => copyText("account", manualPayment.account)}
                >
                  {manualPayment.account}
                </button>
              </div>
              {manualPayment.qrImage && (
                <div className="qr-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={manualPayment.qrImage}
                    alt={manualPayment.channel}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                </div>
              )}
              <div className="payment-status">
                <span className="status-dot" />
                <span>
                  {copy.manualReference}
                  <b className="numeric">{props.orderId}</b>
                </span>
              </div>
              {manualPayment.instructions && (
                <p className="deadline-sub">{manualPayment.instructions}</p>
              )}
            </section>
          )}

          {/* —— 卡密交付 —— */}
          {status === "fulfilled" && secret && (
            <section className="manual-transfer-panel">
              <div className="warning-title">
                <span className="warning-icon">✓</span>
                <span>{copy.yourCode}</span>
              </div>
              <pre className="numeric whitespace-pre-wrap break-all rounded-xl bg-white p-4 text-[14px] leading-relaxed">
                {secret}
              </pre>
              {leaveMessage && (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#60646c]">
                  {leaveMessage}
                </p>
              )}
            </section>
          )}

          {status === "fulfilled" && !secret && (
            <section className="warning-panel">
              <p className="warning-note">
                {copy.enterPassword}{" "}
                <a href="/lookup" className="text-[#0d74ce] underline">
                  {copy.openLookup}
                </a>
              </p>
            </section>
          )}

          {/* —— 预订单 —— */}
          {status === "reserved" && props.canRefundReservation && refundState !== "done" && (
            <button
              type="button"
              onClick={refundReservation}
              disabled={refundState === "busy"}
              className="tokyo-button tokyo-button-light tokyo-button-block"
            >
              <span>{refundState === "busy" ? copy.refunding : copy.refundReservation}</span>
            </button>
          )}
          {refundState === "done" && (
            <p className="tokyo-field-hint">{copy.refundedToBalance}</p>
          )}
          {refundState === "error" && (
            <p role="alert" className="tokyo-field-error">
              {copy.refundFailed}
            </p>
          )}

          {/* —— 订单信息 —— */}
          <div className="order-meta" style={{ marginTop: 4 }}>
            <div className="meta-line">
              <span>{copy.item}</span>
              <span className="meta-pill">
                {props.productName}
                {props.race ? ` · ${props.race}` : ""}
              </span>
              <span>{copy.quantity}</span>
              <span className="meta-pill numeric">{props.quantity}</span>
              <span>{copy.total}</span>
              <span className="meta-pill numeric">
                {props.payAmount} {props.currency}
                {props.payAmountCny ? ` ${props.payAmountCny}` : ""}
              </span>
            </div>
            <div className="meta-line">
              <span>{copy.placed}</span>
              <span className="meta-pill numeric">
                {new Date(props.createdAt).toISOString().slice(0, 16).replace("T", " ")}
              </span>
            </div>
          </div>

          <p className="deadline-sub">
            {copy.bookmark}{" "}
            <a href="/lookup" className="text-[#0d74ce]">
              {copy.lookupLink}
            </a>{" "}
            {copy.bookmarkTail}
          </p>
        </div>
      </section>
    </main>
  );
}
