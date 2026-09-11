"use client";

/**
 * 购买框 —— 结构照搬 Shopify Dawn 的 buy box：
 * 规格选择 → 数量步进 → 价格 → 通栏主按钮。
 *
 * 刻意保持**一屏内可完成**：多一步就多一批放弃的人，而这是整个站唯一
 * 产生收入的界面。表单语义严格按规范：label 在 input 上方，错误在下方，
 * 没有拿 placeholder 当 label 的偷懒写法。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Variant {
  race: string;
  price: string;
  stock: number;
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
}

const FIELD =
  "h-11 w-full rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-raised)] px-3 text-[14px] text-[var(--text)] placeholder:text-[var(--text-faint)]";

export function BuyForm({
  supplierId,
  code,
  currency,
  variants,
  chains,
  balance,
  labels,
}: {
  supplierId: string;
  code: string;
  currency: string;
  variants: Variant[];
  chains: { id: string }[];
  /** 登录用户的余额；未登录为 null。 */
  balance: string | null;
  labels: BuyLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [race, setRace] = useState(variants[0]?.race ?? "");
  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [payMethod, setPayMethod] = useState<"chain" | "balance">("chain");
  const [chainId, setChainId] = useState(chains[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<{ code: string; discount: string } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [checkingCoupon, setCheckingCoupon] = useState(false);

  const selected = variants.find((item) => item.race === race) ?? variants[0];
  const unitPrice = Number(selected?.price ?? 0);
  const subtotal = unitPrice * quantity;
  const discount = coupon ? Number(coupon.discount) : 0;
  const total = Math.max(0, subtotal - discount).toFixed(2);

  const soldOut = (selected?.stock ?? 0) < quantity;
  const noChain = chains.length === 0;
  const balanceEnough = balance !== null && Number(balance) >= Number(total);
  const canPay = payMethod === "balance" ? balanceEnough : !noChain;

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

  return (
    <form onSubmit={submit}>
      {variants.length > 1 && (
        <fieldset>
          <legend className="eyebrow">{labels.option}</legend>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {variants.map((variant) => {
              const active = variant.race === race;
              return (
                <label
                  key={variant.race}
                  className={`cursor-pointer rounded-[var(--radius-card)] border px-3 py-2 text-[13px] transition-colors ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                      : "border-[var(--line-strong)] hover:border-[var(--text)]"
                  }`}
                >
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
                  {variant.race || labels.standard}
                  <span className="numeric ml-2 opacity-70">{variant.price}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {/* 数量步进器：Dawn 的做法，比裸 number input 在触屏上好用得多。 */}
      <div className="mt-5">
        <label htmlFor="quantity" className="eyebrow">
          {labels.quantity}
        </label>
        <div className="mt-2.5 inline-flex h-11 items-center rounded-[var(--radius-card)] border border-[var(--line-strong)]">
          <button
            type="button"
            aria-label="-"
            onClick={() => {
              setQuantity((value) => Math.max(1, value - 1));
              invalidateCoupon();
            }}
            className="h-full w-11 text-[18px] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            −
          </button>
          <input
            id="quantity"
            type="number"
            min={1}
            max={Math.max(1, Math.min(99, selected?.stock ?? 1))}
            value={quantity}
            onChange={(event) => {
              setQuantity(Math.max(1, Number(event.target.value) || 1));
              invalidateCoupon();
            }}
            className="numeric h-full w-14 border-x border-[var(--line-strong)] bg-transparent text-center text-[14px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            type="button"
            aria-label="+"
            onClick={() => {
              setQuantity((value) => Math.min(99, value + 1));
              invalidateCoupon();
            }}
            className="h-full w-11 text-[18px] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            +
          </button>
        </div>
      </div>

      <div className="mt-5">
        <label htmlFor="email" className="eyebrow">
          {labels.email}
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={`${FIELD} mt-2.5`}
          placeholder="you@example.com"
        />
        <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">{labels.emailHint}</p>
      </div>

      <div className="mt-4">
        <label htmlFor="orderPassword" className="eyebrow">
          {labels.password}
        </label>
        <input
          id="orderPassword"
          type="password"
          required
          minLength={4}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${FIELD} mt-2.5`}
        />
        <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">{labels.passwordHint}</p>
      </div>

      {/* 优惠码 */}
      <div className="mt-4">
        <label htmlFor="coupon" className="eyebrow">
          {labels.couponLabel}
        </label>
        <div className="mt-2.5 flex gap-2">
          <input
            id="coupon"
            value={coupon ? coupon.code : couponInput}
            disabled={Boolean(coupon)}
            onChange={(event) => setCouponInput(event.target.value)}
            className={`${FIELD} uppercase disabled:opacity-60`}
          />
          <button
            type="button"
            onClick={coupon ? () => setCoupon(null) : applyCoupon}
            disabled={checkingCoupon}
            className="h-11 shrink-0 rounded-[var(--radius-card)] border border-[var(--line-strong)] px-4 text-[13px] hover:border-[var(--text)] disabled:opacity-50"
          >
            {coupon ? labels.couponRemove : labels.couponApply}
          </button>
        </div>
        {couponError && (
          <p role="alert" className="mt-1.5 text-[12px] text-[var(--danger)]">
            {couponError}
          </p>
        )}
      </div>

      {/* 支付方式：登录后才出现余额选项 */}
      {(balance !== null || chains.length > 1) && (
        <fieldset className="mt-5">
          <legend className="eyebrow">{labels.payWith}</legend>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {balance !== null && (
              <label
                className={`cursor-pointer rounded-[var(--radius-card)] border px-3 py-2 text-[13px] ${
                  payMethod === "balance"
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "border-[var(--line-strong)]"
                }`}
              >
                <input
                  type="radio"
                  name="payMethod"
                  className="sr-only"
                  checked={payMethod === "balance"}
                  onChange={() => setPayMethod("balance")}
                />
                {labels.payWithBalance}
                <span className="numeric ml-2 opacity-70">{balance}</span>
              </label>
            )}
            {chains.map((chain) => (
              <label
                key={chain.id}
                className={`cursor-pointer rounded-[var(--radius-card)] border px-3 py-2 text-[13px] uppercase ${
                  payMethod === "chain" && chainId === chain.id
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "border-[var(--line-strong)]"
                }`}
              >
                <input
                  type="radio"
                  name="payMethod"
                  className="sr-only"
                  checked={payMethod === "chain" && chainId === chain.id}
                  onChange={() => {
                    setPayMethod("chain");
                    setChainId(chain.id);
                  }}
                />
                {chain.id}
              </label>
            ))}
          </div>
          {payMethod === "balance" && !balanceEnough && (
            <p className="mt-2 text-[12px] text-[var(--danger)]">{labels.insufficient}</p>
          )}
        </fieldset>
      )}

      {/* 价格汇总。有折扣时展示小计与优惠，让客户看得见券生效了。 */}
      <div className="mt-6 border-t border-[var(--line)] pt-4">
        {coupon && (
          <>
            <div className="flex items-baseline justify-between text-[13px] text-[var(--text-muted)]">
              <span>{labels.subtotal}</span>
              <span className="numeric">{subtotal.toFixed(2)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between text-[13px] text-[var(--pop)]">
              <span>{labels.discount}</span>
              <span className="numeric">-{coupon.discount}</span>
            </div>
          </>
        )}
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-[13px] text-[var(--text-muted)]">{labels.total}</span>
          <span className="numeric text-[24px] font-semibold">
            {total}
            <span className="ml-1.5 font-sans text-[13px] font-normal text-[var(--text-faint)]">
              {currency}
            </span>
          </span>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-[var(--radius-card)] bg-[var(--danger-wash)] px-3 py-2 text-[13px] text-[var(--danger)]"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || soldOut || !canPay}
        className="mt-4 h-12 w-full rounded-[var(--radius-card)] bg-[var(--accent)] text-[14px] font-medium text-[var(--accent-fg)] transition-[background-color,transform] hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
      >
        {soldOut
          ? labels.soldOut
          : !canPay
            ? labels.notConfigured
            : pending
              ? labels.creating
              : labels.submit}
      </button>

      {payMethod === "chain" && (
        <p className="mt-3 text-center text-[12px] text-[var(--text-faint)]">
          {labels.window}
        </p>
      )}
    </form>
  );
}
