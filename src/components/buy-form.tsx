"use client";

/**
 * 下单表单。
 *
 * 客户端组件，因为规格选择要实时改价。刻意保持**一屏内可完成** ——
 * 多一步就多一批放弃的人，而这是整个站唯一产生收入的界面。
 *
 * 表单语义严格按规范：label 在 input 上方，错误在下方，没有
 * placeholder 当 label 用的偷懒写法。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Variant {
  race: string;
  price: string;
  stock: number;
}

interface Chain {
  id: string;
  confirmations: number;
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
}

export function BuyForm({
  supplierId,
  code,
  currency,
  variants,
  chains,
  labels,
}: {
  supplierId: string;
  code: string;
  currency: string;
  variants: Variant[];
  chains: Chain[];
  labels: BuyLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [race, setRace] = useState(variants[0]?.race ?? "");
  const [chainId, setChainId] = useState(chains[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selected = variants.find((item) => item.race === race) ?? variants[0];
  const unitPrice = Number(selected?.price ?? 0);
  const total = (unitPrice * quantity).toFixed(2);
  const soldOut = (selected?.stock ?? 0) < quantity;
  const noChain = chains.length === 0;

  async function submit(event: React.FormEvent) {
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
          chainId,
          contactEmail: email,
          queryPassword: password,
        }),
      });

      const data = (await response.json()) as
        | { ok: true; orderId: string }
        | { ok: false; error: string };

      if (!data.ok) {
        setError(data.error);
        return;
      }
      // 口令带在 URL 里只为这一跳免去二次输入；订单页会把它换成 sessionStorage。
      router.push(`/orders/${data.orderId}?k=${encodeURIComponent(password)}`);
    });
  }

  const fieldClass =
    "h-11 w-full rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-raised)] px-3 text-[14px] text-[var(--text)] placeholder:text-[var(--text-faint)]";

  return (
    <form
      onSubmit={submit}
      className="rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--bg-raised)] p-5"
    >
      {variants.length > 1 && (
        <fieldset>
          <legend className="text-[13px] font-medium">{labels.option}</legend>
          <div className="mt-2 grid gap-2">
            {variants.map((variant) => {
              const active = variant.race === race;
              return (
                <label
                  key={variant.race}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-card)] border px-3 py-2.5 text-[14px] transition-colors ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-wash)]"
                      : "border-[var(--line-strong)] hover:border-[var(--text-faint)]"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <input
                      type="radio"
                      name="race"
                      className="sr-only"
                      checked={active}
                      onChange={() => setRace(variant.race)}
                    />
                    <span className="truncate">{variant.race || labels.standard}</span>
                  </span>
                  <span className="numeric shrink-0 font-medium">{variant.price}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className={variants.length > 1 ? "mt-5" : ""}>
        <label htmlFor="quantity" className="text-[13px] font-medium">
          {labels.quantity}
        </label>
        <input
          id="quantity"
          type="number"
          min={1}
          max={Math.max(1, Math.min(99, selected?.stock ?? 1))}
          value={quantity}
          onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
          className={`${fieldClass} numeric mt-2`}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="email" className="text-[13px] font-medium">
          {labels.email}
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={`${fieldClass} mt-2`}
          placeholder="you@example.com"
        />
        <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">
          {labels.emailHint}
        </p>
      </div>

      <div className="mt-4">
        <label htmlFor="password" className="text-[13px] font-medium">
          {labels.password}
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={4}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${fieldClass} mt-2`}
        />
        <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">
          {labels.passwordHint}
        </p>
      </div>

      {chains.length > 1 && (
        <fieldset className="mt-4">
          <legend className="text-[13px] font-medium">{labels.payWith}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {chains.map((chain) => (
              <label
                key={chain.id}
                className={`cursor-pointer rounded-[var(--radius-card)] border px-3 py-2 text-[13px] uppercase transition-colors ${
                  chain.id === chainId
                    ? "border-[var(--accent)] bg-[var(--accent-wash)] text-[var(--accent)]"
                    : "border-[var(--line-strong)]"
                }`}
              >
                <input
                  type="radio"
                  name="chain"
                  className="sr-only"
                  checked={chain.id === chainId}
                  onChange={() => setChainId(chain.id)}
                />
                {chain.id}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="mt-6 flex items-baseline justify-between border-t border-[var(--line)] pt-4">
        <span className="text-[13px] text-[var(--text-muted)]">{labels.total}</span>
        <span className="numeric text-[22px] font-semibold">
          {total}
          <span className="ml-1.5 font-sans text-[13px] font-normal text-[var(--text-faint)]">
            {currency}
          </span>
        </span>
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
        disabled={pending || soldOut || noChain}
        className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-[var(--radius-card)] bg-[var(--accent)] text-[14px] font-medium text-[var(--accent-fg)] transition-[background-color,transform] hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
      >
        {noChain
          ? labels.notConfigured
          : soldOut
            ? labels.soldOut
            : pending
              ? labels.creating
              : labels.submit}
      </button>

      <p className="mt-3 text-center text-[12px] text-[var(--text-faint)]">
        {labels.window}
      </p>
    </form>
  );
}
