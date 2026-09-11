import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { PageFrame } from "@/components/page-frame";
import { loadPage, userSummary } from "@/runtime/page-context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create account", robots: { index: false } };

export default async function RegisterPage() {
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
        mode="register"
        labels={{
          title: t.account.signUp,
          email: t.account.email,
          password: t.account.password,
          passwordHint: t.account.passwordHint,
          submit: t.account.signUp,
          switchPrompt: t.account.haveAccount,
          switchAction: t.account.signIn,
          switchHref: "/account/login",
          errors: {
            email_taken: t.account.emailTaken,
            weak_password: t.account.weakPassword,
            invalid_email: t.account.invalidEmail,
            generic: t.account.invalidEmail,
          },
        }}
      />
    </PageFrame>
  );
}
