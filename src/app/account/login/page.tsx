import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PageFrame } from "@/components/page-frame";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function LoginPage() {
  const loaded = await loadPage({ categories: false });
  if (!loaded.ok) redirect("/");

  const { context, locale, t, user, banner } = loaded.page;
  if (user) redirect("/account");

  return (
    <PageFrame
      storeName={context.config.store.name}
      currency={context.config.store.currency}
      supportEmail={context.config.store.supportEmail ?? null}
      locale={locale}
      t={t}
      user={userSummary(user)}
      bannerText={banner?.bannerText ?? null}
      width="max-w-md"
    >
      <AuthForm
        mode="login"
        labels={{
          title: t.account.signIn,
          email: t.account.email,
          password: t.account.password,
          passwordHint: t.account.passwordHint,
          submit: t.account.signIn,
          switchPrompt: t.account.noAccount,
          switchAction: t.account.signUp,
          switchHref: "/account/register",
          errors: {
            bad_credentials: t.account.badCredentials,
            generic: t.account.badCredentials,
          },
        }}
      />
    </PageFrame>
  );
}
