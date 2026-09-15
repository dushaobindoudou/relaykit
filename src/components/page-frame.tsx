/**
 * 非商品页的通用外框（账号、帮助、订单查询）。
 *
 * 与首页共用同一个 Tokyo 头部；内容区统一套 checkout-shell 面板
 * （源站收银台的白卡），保持「同一家店」的观感。源站没有站点页脚，
 * 这里同样不设。
 */

import { StoreHeader } from "@/components/storefront";
import type { Dict, Locale } from "@/i18n/dictionary";

export function PageFrame({
  storeName,
  supportUrl,
  locale,
  t,
  user,
  width = "720px",
  children,
}: {
  storeName: string;
  currency: string;
  supportEmail: string | null;
  /** 在线客服地址（可选）。 */
  supportUrl?: string | null;
  locale: Locale;
  t: Dict;
  user: { email: string; balance: string } | null;
  bannerText?: string | null;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <StoreHeader
        storeName={storeName}
        locale={locale}
        t={t}
        user={user}
        supportUrl={supportUrl ?? null}
      />
      <main className="checkout-page">
        <section className="checkout-shell" style={{ maxWidth: width }}>
          <div className="checkout-body">{children}</div>
        </section>
      </main>
    </>
  );
}
