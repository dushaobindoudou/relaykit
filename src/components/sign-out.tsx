"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.push("/");
          router.refresh();
        })
      }
      className="text-[13px] text-[var(--text-muted)] underline underline-offset-4 hover:text-[var(--text)]"
    >
      {label}
    </button>
  );
}
