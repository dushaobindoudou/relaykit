"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const PRESETS = ["10", "25", "50", "100", "200"];

export function TopupForm({
  currency,
  chains,
  labels,
}: {
  currency: string;
  chains: { id: string }[];
  labels: {
    amount: string;
    payWith: string;
    submit: string;
    creating: string;
    notConfigured: string;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState("25");
  const [chainId, setChainId] = useState(chains[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const response = await fetch("/api/topups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, chainId }),
      });
      const data = (await response.json()) as
        | { ok: true; topupId: string }
        | { ok: false; error: string };

      if (!data.ok) {
        setError(data.error);
        return;
      }
      router.push(`/account/topup/${data.topupId}`);
    });
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="amount" className="eyebrow">
        {labels.amount}
      </label>

      {/* 预设金额：绝大多数人不想思考充多少，给几个常用档能明显提高完成率。 */}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setAmount(preset)}
            className={`numeric rounded-[var(--radius-card)] border px-3 py-2 text-[13px] ${
              amount === preset
                ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                : "border-[var(--line-strong)]"
            }`}
          >
            {preset}
          </button>
        ))}
      </div>

      <div className="relative mt-3">
        <input
          id="amount"
          type="number"
          min="1"
          step="0.01"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="numeric h-11 w-full rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-raised)] px-3 pr-16 text-[14px]"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--text-faint)]">
          {currency}
        </span>
      </div>

      {chains.length > 1 && (
        <fieldset className="mt-5">
          <legend className="eyebrow">{labels.payWith}</legend>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {chains.map((chain) => (
              <label
                key={chain.id}
                className={`cursor-pointer rounded-[var(--radius-card)] border px-3 py-2 text-[13px] uppercase ${
                  chainId === chain.id
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                    : "border-[var(--line-strong)]"
                }`}
              >
                <input
                  type="radio"
                  name="chain"
                  className="sr-only"
                  checked={chainId === chain.id}
                  onChange={() => setChainId(chain.id)}
                />
                {chain.id}
              </label>
            ))}
          </div>
        </fieldset>
      )}

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
        disabled={pending || chains.length === 0}
        className="mt-5 h-11 w-full rounded-[var(--radius-card)] bg-[var(--accent)] text-[14px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-45"
      >
        {chains.length === 0
          ? labels.notConfigured
          : pending
            ? labels.creating
            : labels.submit}
      </button>
    </form>
  );
}
