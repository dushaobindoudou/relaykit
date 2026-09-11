/**
 * 非商品页的通用外框（账号、帮助、订单查询）。
 *
 * 与首页共用同一套头部/页脚，保证客户在站内任何位置看到的都是同一个店。
 */

import {
  AnnouncementBar,
  StoreFooter,
  StoreHeader,
} from "@/components/storefront";
import type { Dict, Locale } from "@/i18n/dictionary";

export function PageFrame({
  storeName,
  currency,
  supportEmail,
  supportUrl,
  locale,
  t,
  user,
  bannerText,
  width = "max-w-3xl",
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
      {bannerText && <AnnouncementBar text={bannerText} />}
      <StoreHeader
        storeName={storeName}
        locale={locale}
        t={t}
        user={user}
        showSearch={false}
      />
      <main className={`mx-auto ${width} px-4 py-10 sm:px-6 sm:py-14`}>{children}</main>
      <StoreFooter
        storeName={storeName}
        currency={currency}
        supportEmail={supportEmail}
        supportUrl={supportUrl ?? null}
        t={t}
      />
    </>
  );
}
