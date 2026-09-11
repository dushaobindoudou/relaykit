"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export interface AuthLabels {
  title: string;
  email: string;
  password: string;
  passwordHint: string;
  submit: string;
  switchPrompt: string;
  switchAction: string;
  switchHref: string;
  errors: Record<string, string>;
}

export function AuthForm({
  mode,
  labels,
}: {
  mode: "login" | "register";
  labels: AuthLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const field =
    "h-11 w-full rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-raised)] px-3 text-[14px]";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };

      if (!data.ok) {
        // 服务端返回的是错误码，文案在这里按语言映射 —— 后端不该关心显示语言。
        setError(labels.errors[data.error ?? ""] ?? labels.errors.generic ?? "Error");
        return;
      }
      router.push("/account");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-sm">
      <h1 className="text-[24px] font-semibold tracking-[-0.015em]">{labels.title}</h1>

      <div className="mt-7">
        <label htmlFor="email" className="eyebrow">
          {labels.email}
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={`${field} mt-2.5`}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="password" className="eyebrow">
          {labels.password}
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={mode === "register" ? 8 : 1}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${field} mt-2.5`}
        />
        {mode === "register" && (
          <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">
            {labels.passwordHint}
          </p>
        )}
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
        className="mt-5 h-11 w-full rounded-[var(--radius-card)] bg-[var(--accent)] text-[14px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
      >
        {labels.submit}
      </button>

      <p className="mt-5 text-center text-[13px] text-[var(--text-muted)]">
        {labels.switchPrompt}{" "}
        <Link href={labels.switchHref} className="text-[var(--pop)] underline underline-offset-4">
          {labels.switchAction}
        </Link>
      </p>
    </form>
  );
}
