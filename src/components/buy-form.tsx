"use client";

/**
 * 购买框 —— 结构照搬源站 Tokyo 主题的商品页表单：
 * SKU 芯片（带单价）→ 联系方式 → 查询密码 → 数量步进 → 支付方式 pill
 * → 合计 → 通栏主按钮。提交前弹「下单提示」协议门（与源站一致：
 * 反诈声明 + 支付建议，勾选确认后才能继续）。
 *
 * 与源站的有意差异：支付方式直接展示在表单里 —— 链上 USDT 之外，
 * 我们的支付宝/微信人工通道是差异优势，必须在下单前被看见。
 * 逻辑层（规格/优惠券/余额/人工渠道计价）沿用原有实现。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cnyNote } from "@/pricing/cny";

interface Variant {
  race: string;
  price: string;
  stock: number;
  /** 手动收款渠道（支付宝/微信）的单价；未启用手动收款时缺省。 */
  manualPrice?: string;
}

/**
 * 文案由服务端求值后传入。
 *
 * 不直接传整个字典：里面有函数型文案（`window(minutes)`），
 * 而函数不能跨 RSC 边界序列化 —— 传了会在运行时静默变成 undefined。
 */
export interface BuyLabels {
  option: string;
  standard: string;
  quantity: string;
  email: string;
  emailHint: string;
  password: string;
  passwordHint: string;
  payWith: string;
  total: string;
  submit: string;
  creating: string;
  soldOut: string;
  /** 预订模式的按钮文案。 */
  reserveSubmit: string;
  notConfigured: string;
  window: string;
  couponLabel: string;
  couponApply: string;
  couponRemove: string;
  subtotal: string;
  discount: string;
  payWithBalance: string;
  insufficient: string;
  balanceLabel: string;
  chainPay: string;
  noticeTitle: string;
  noticeBody: string;
  noticeBodyPay: string;
  noticeAgree: string;
  noticeConfirm: string;
  noticeCancel: string;
}

export function BuyForm({
  supplierId,
  code,
  currency,
  cnyRate,
  variants,
  chains,
  manual,
  balance,
  reservable = false,
  labels,
}: {
  supplierId: string;
  code: string;
  currency: string;
  /** 人民币参考价汇率（CNY_USDT）；null 则只显示 USDT 主价。 */
  cnyRate: string | null;
  variants: Variant[];
  chains: { id: string }[];
  /** 手动收款渠道（支付宝/微信转账）。未启用为 null。 */
  manual: { channels: { id: string; label: string }[]; note: string } | null;
  /** 登录用户的余额；未登录为 null。 */
  balance: string | null;
  /** 缺货时可预订：按钮变为「预订购买」，提交与普通单一致（服务端标记）。 */
  reservable?: boolean;
  labels: BuyLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [race, setRace] = useState(variants[0]?.race ?? "");
  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [payMethod, setPayMethod] = useState<string>("chain");
  const [chainId, setChainId] = useState(chains[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeAgreed, setNoticeAgreed] = useState(false);

  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<{ code: string; discount: string } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [checkingCoupon, setCheckingCoupon] = useState(false);

  const selected = variants.find((item) => item.race === race) ?? variants[0];
  const isManual = payMethod !== "chain" && payMethod !== "balance";
  // 手动收款渠道按成本口径单独计价（30%），切渠道时总价跟着切。
  const unitPrice = isManual
    ? Number(selected?.manualPrice ?? selected?.price ?? 0)
    : Number(selected?.price ?? 0);
  const subtotal = unitPrice * quantity;
  const discount = coupon ? Number(coupon.discount) : 0;
  const total = Math.max(0, subtotal - discount).toFixed(2);

  const soldOut = (selected?.stock ?? 0) < quantity && !reservable;
  const noChain = chains.length === 0;
  const balanceEnough = balance !== null && Number(balance) >= Number(total);
  const canPay =
    payMethod === "balance"
      ? balanceEnough
      : payMethod === "chain"
        ? !noChain
        : true;

  /** 换规格或数量后原有折扣可能不再成立（最低消费、毛利护栏），一律清掉重算。 */
  function invalidateCoupon() {
    if (coupon) {
      setCoupon(null);
      setCouponError(null);
    }
  }

  async function applyCoupon() {
    if (!couponInput.trim()) return;
    setCheckingCoupon(true);
    setCouponError(null);

    try {
      const response = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: couponInput,
          supplierId,
          code_: code,
          race,
          quantity,
          email,
        }),
      });
      const data = (await response.json()) as
        | { ok: true; discount: string }
        | { ok: false; error: string };

      if (data.ok) setCoupon({ code: couponInput.trim().toUpperCase(), discount: data.discount });
      else setCouponError(data.error);
    } finally {
      setCheckingCoupon(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    // 协议门：与源站一致，确认过才放行；勾选后本会话内不再打扰。
    if (!noticeAgreed) {
      setNoticeOpen(true);
      return;
    }

    startTransition(async () => {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          code,
          race,
          quantity,
          payMethod,
          chainId,
          contactEmail: email,
          queryPassword: password,
          couponCode: coupon?.code,
        }),
      });

      const data = (await response.json()) as
        | { ok: true; orderId: string }
        | { ok: false; error: string };

      if (!data.ok) {
        setError(data.error);
        return;
      }
      // 口令带在 URL 里只为这一跳免去二次输入；订单页会把它换进 sessionStorage。
      router.push(`/orders/${data.orderId}?k=${encodeURIComponent(password)}`);
    });
  }

  const chainPill = (active: boolean) =>
    `switch-race sku tokyo-sku-option${active ? " is-primary" : ""}`;

  return (
    <>
      <form onSubmit={submit} className="vstack gap-3 tokyo-form-stack">
        {variants.length > 1 && (
          <div className="tokyo-field">
            <label className="form-label mb-1">{labels.option}</label>
            <div className="sku-list">
              {variants.map((variant) => {
                const active = variant.race === race;
                return (
                  <label key={variant.race} className={chainPill(active)}>
                    <input
                      type="radio"
                      name="race"
                      className="sr-only"
                      checked={active}
                      onChange={() => {
                        setRace(variant.race);
                        invalidateCoupon();
                      }}
                    />
                    <span className="tokyo-sku-prices">
                      <span className="tokyo-sku-current-price">
                        {variant.price} {currency}
                        {cnyNote(variant.price, cnyRate) && (
                          <span className="tokyo-price-cny">{cnyNote(variant.price, cnyRate)}</span>
                        )}
                      </span>
                    </span>
                    <span className="tokyo-sku-name">{variant.race || labels.standard}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div className="tokyo-field">
          <label className="form-label mb-1" htmlFor="buyEmail">
            {labels.email}
          </label>
          <input
            id="buyEmail"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="form-control"
            placeholder="you@example.com"
          />
          <p className="tokyo-field-hint">{labels.emailHint}</p>
        </div>

        <div className="tokyo-field">
          <label className="form-label mb-1" htmlFor="orderPassword">
            {labels.password}
          </label>
          <input
            id="orderPassword"
            type="password"
            required
            minLength={4}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="form-control"
          />
          <p className="tokyo-field-hint">{labels.passwordHint}</p>
        </div>

        <div className="tokyo-field">
          <label className="form-label mb-1">{labels.quantity}</label>
          <div className="input-group qty-group">
            <button
              type="button"
              className="change-num-sub"
              aria-label="-"
              onClick={() => {
                setQuantity((value) => Math.max(1, value - 1));
                invalidateCoupon();
              }}
            >
              <i className="fa-duotone fa-regular fa-minus" aria-hidden />
            </button>
            <input
              type="number"
              className="form-control text-center"
              min={1}
              max={Math.max(1, Math.min(99, selected?.stock ?? 1))}
              value={quantity}
              onChange={(event) => {
                setQuantity(Math.max(1, Number(event.target.value) || 1));
                invalidateCoupon();
              }}
            />
            <button
              type="button"
              className="change-num-add"
              aria-label="+"
              onClick={() => {
                setQuantity((value) => Math.min(99, value + 1));
                invalidateCoupon();
              }}
            >
              <i className="fa-duotone fa-regular fa-plus" aria-hidden />
            </button>
          </div>
        </div>

        {/* 优惠码 */}
        <div className="tokyo-field">
          <label className="form-label mb-1" htmlFor="coupon">
            {labels.couponLabel}
          </label>
          <div className="d-flex gap-2">
            <input
              id="coupon"
              value={coupon ? coupon.code : couponInput}
              disabled={Boolean(coupon)}
              onChange={(event) => setCouponInput(event.target.value)}
              className="form-control text-uppercase"
            />
            <button
              type="button"
              onClick={coupon ? () => setCoupon(null) : applyCoupon}
              disabled={checkingCoupon}
              className="tokyo-button tokyo-button-light"
            >
              <span>{coupon ? labels.couponRemove : labels.couponApply}</span>
            </button>
          </div>
          {couponError && (
            <p role="alert" className="tokyo-field-error">
              {couponError}
            </p>
          )}
        </div>

        {/* 支付方式：链上 USDT + 我们的人工通道（差异优势，必须可见） */}
        <div className="tokyo-field">
          <label className="form-label mb-1">{labels.payWith}</label>
          <div className="sku-list">
            <label className={chainPill(payMethod === "chain")}>
              <input
                type="radio"
                name="payMethod"
                className="sr-only"
                checked={payMethod === "chain"}
                onChange={() => setPayMethod("chain")}
              />
              <span className="tokyo-sku-name">
                <i className="fa-duotone fa-solid fa-bolt me-1" aria-hidden />
                {labels.chainPay}
              </span>
            </label>
            {balance !== null && (
              <label className={chainPill(payMethod === "balance")}>
                <input
                  type="radio"
                  name="payMethod"
                  className="sr-only"
                  checked={payMethod === "balance"}
                  onChange={() => setPayMethod("balance")}
                />
                <span className="tokyo-sku-name">
                  {labels.payWithBalance}
                  <span className="tokyo-sku-current-price ms-1">{balance}</span>
                </span>
              </label>
            )}
            {manual?.channels.map((channel) => (
              <label key={channel.id} className={chainPill(payMethod === channel.id)}>
                <input
                  type="radio"
                  name="payMethod"
                  className="sr-only"
                  checked={payMethod === channel.id}
                  onChange={() => setPayMethod(channel.id)}
                />
                <span className="tokyo-sku-name">
                  <i className="fa-duotone fa-solid fa-comments me-1" aria-hidden />
                  {channel.label}
                </span>
              </label>
            ))}
          </div>
          {isManual && manual?.note && <p className="tokyo-field-hint">{manual.note}</p>}
          {payMethod === "balance" && !balanceEnough && (
            <p role="alert" className="tokyo-field-error">
              {labels.insufficient}
            </p>
          )}
        </div>

        {/* 价格汇总。有折扣时展示小计与优惠，让客户看得见券生效了。 */}
        <div className="tokyo-item-price abacus">
          <div className="price">
            {coupon && (
              <span className="tokyo-price-sub">
                {labels.subtotal} {subtotal.toFixed(2)} · {labels.discount} -{coupon.discount}
              </span>
            )}
            <span className="tokyo-price-main numeric">
              {total} <small>{currency}</small>
              {cnyNote(total, cnyRate) && (
                <span className="tokyo-price-cny">{cnyNote(total, cnyRate)}</span>
              )}
            </span>
          </div>
        </div>

        {error && (
          <p role="alert" className="tokyo-field-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || soldOut || !canPay}
          className="tokyo-button tokyo-button-dark tokyo-button-block"
        >
          {soldOut
            ? labels.soldOut
            : !canPay
              ? labels.notConfigured
              : pending
                ? labels.creating
                : reservable
                  ? labels.reserveSubmit
                  : labels.submit}
        </button>

        {payMethod === "chain" && <p className="tokyo-field-hint text-center">{labels.window}</p>}
      </form>

      {/* 下单提示（协议门）—— 源站 order-payment-notice 的结构与样式。 */}
      {noticeOpen && (
        <div className="order-payment-notice" id="order-payment-notice">
          <div className="order-payment-notice__backdrop" onClick={() => setNoticeOpen(false)} />
          <section
            className="order-payment-notice__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-notice-title"
          >
            <header>
              <h3 id="order-notice-title">{labels.noticeTitle}</h3>
              <button type="button" aria-label={labels.noticeCancel} onClick={() => setNoticeOpen(false)}>
                &times;
              </button>
            </header>
            <div className="order-payment-notice__content">
              <p>{labels.noticeBody}</p>
              <p>{labels.noticeBodyPay}</p>
            </div>
            <label className="order-payment-notice__agreement">
              <input
                type="checkbox"
                checked={noticeAgreed}
                onChange={(event) => setNoticeAgreed(event.target.checked)}
              />{" "}
              <span>{labels.noticeAgree}</span>
            </label>
            <footer>
              <button type="button" className="order-payment-notice__cancel" onClick={() => setNoticeOpen(false)}>
                {labels.noticeCancel}
              </button>
              <button
                type="button"
                className="order-payment-notice__confirm"
                disabled={!noticeAgreed}
                onClick={() => {
                  setNoticeOpen(false);
                  // 已经勾选：直接走一遍提交流程（submit 是受控表单提交）。
                  (document.activeElement as HTMLElement)?.blur();
                  const form = document.querySelector<HTMLFormElement>("form.tokyo-form-stack");
                  const requestSubmit = form?.requestSubmit.bind(form);
                  if (requestSubmit) requestSubmit();
                }}
              >
                {labels.noticeConfirm}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
