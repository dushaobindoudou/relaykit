"use client";

/**
 * 付款指引。订单页与充值页共用。
 *
 * 金额与地址用等宽字体并提供一键复制 —— 手抄一个 42 位地址或一个带四位
 * 小数的金额是真实的出错来源，而**抄错金额会导致订单匹配不上**，
 * 客户付了钱却收不到货，是最难处理的一类客诉。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface PaymentCopy {
  sendExactly: string;
  left: string;
  address: string;
  amount: string;
  copy: string;
  copied: string;
  exactDecimals: string;
}

function CopyRow({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const doCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板在不安全上下文会被拒。值本身就在页面上可以手选，静默降级即可。
    }
  }, [value]);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-[var(--text-muted)]">{label}</span>
        <button
          type="button"
          onClick={doCopy}
          className="text-[12px] text-[var(--pop)] hover:underline"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <p className="numeric mt-1.5 break-all rounded-[var(--radius-card)] bg-[var(--bg-raised)] px-3 py-2.5 text-[13px]">
        {value}
      </p>
    </div>
  );
}

function Countdown({ endsAt, suffix }: { endsAt: string; suffix: string }) {
  const [left, setLeft] = useState(() =>
    Math.max(0, new Date(endsAt).getTime() - Date.now()),
  );

  useEffect(() => {
    const timer = setInterval(
      () => setLeft(Math.max(0, new Date(endsAt).getTime() - Date.now())),
      1000,
    );
    return () => clearInterval(timer);
  }, [endsAt]);

  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);

  return (
    <span className="text-[12px] text-[var(--text-muted)]">
      <span className="numeric">
        {minutes}:{String(seconds).padStart(2, "0")}
      </span>{" "}
      {suffix}
    </span>
  );
}

export function PaymentInstructions({
  amount,
  address,
  chainId,
  currency,
  endsAt,
  copy,
  pollUrl,
  settledRedirect,
}: {
  amount: string;
  address: string;
  chainId: string;
  currency: string;
  endsAt: string;
  copy: PaymentCopy;
  /** 轮询状态的接口；返回 {status}。到账后跳转。 */
  pollUrl?: string;
  settledRedirect?: string;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!pollUrl) return;
    let cancelled = false;

    // 3 秒一轮。链上确认本来就要几十秒到几分钟，更密只是白费请求。
    const timer = setInterval(async () => {
      const response = await fetch(pollUrl, { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { status?: string };
      if (data.status && data.status !== "awaiting_payment" && !cancelled) {
        clearInterval(timer);
        if (settledRedirect) router.push(settledRedirect);
        else router.refresh();
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollUrl, settledRedirect, router]);

  return (
    <section className="rounded-[var(--radius-card)] bg-[var(--bg-sunken)] p-5">
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">{copy.sendExactly}</p>
        {endsAt && <Countdown endsAt={endsAt} suffix={copy.left} />}
      </div>

      <p className="numeric mt-3 text-[32px] font-semibold leading-none">
        {amount}
        <span className="ml-2 font-sans text-[14px] font-normal text-[var(--text-muted)]">
          {currency}
        </span>
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
        {copy.exactDecimals}
      </p>

      <div className="mt-5 grid gap-3">
        <CopyRow
          label={`${copy.address} (${chainId.toUpperCase()})`}
          value={address}
          copyLabel={copy.copy}
          copiedLabel={copy.copied}
        />
        <CopyRow
          label={copy.amount}
          value={amount}
          copyLabel={copy.copy}
          copiedLabel={copy.copied}
        />
      </div>
    </section>
  );
}
