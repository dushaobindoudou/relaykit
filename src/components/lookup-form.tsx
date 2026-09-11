"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface LookupLabels {
  title: string;
  intro: string;
  orderNumber: string;
  password: string;
  submit: string;
  checking: string;
  notFound: string;
  failed: string;
}

export function LookupForm({ labels }: { labels: LookupLabels }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [orderId, setOrderId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fieldClass =
    "h-11 w-full rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-raised)] px-3 text-[14px] text-[var(--text)] placeholder:text-[var(--text-faint)]";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const id = orderId.trim().toUpperCase();

    startTransition(async () => {
      const response = await fetch(
        `/api/orders/${encodeURIComponent(id)}?k=${encodeURIComponent(password)}`,
        { cache: "no-store" },
      );
      if (response.status === 404) {
        // 不区分「订单不存在」与「口令错误」，避免被用来枚举订单号。
        setError(labels.notFound);
        return;
      }
      if (!response.ok) {
        setError(labels.failed);
        return;
      }
      sessionStorage.setItem(`relaykit:order:${id}`, password);
      router.push(`/orders/${encodeURIComponent(id)}`);
    });
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="orderId" className="text-[13px] font-medium">
        {labels.orderNumber}
      </label>
      <input
        id="orderId"
        required
        value={orderId}
        onChange={(event) => setOrderId(event.target.value)}
        className={`${fieldClass} numeric mt-2 uppercase`}
        placeholder="ABCDE-FGHIJ"
      />

      <div className="mt-4">
        <label htmlFor="lookupPassword" className="text-[13px] font-medium">
          {labels.password}
        </label>
        <input
          id="lookupPassword"
          type="password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${fieldClass} mt-2`}
        />
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
        disabled={pending}
        className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-[var(--radius-card)] bg-[var(--accent)] text-[14px] font-medium text-[var(--accent-fg)] transition-[background-color,transform] hover:bg-[var(--accent-hover)] active:translate-y-px disabled:opacity-45"
      >
        {pending ? labels.checking : labels.submit}
      </button>
    </form>
  );
}
