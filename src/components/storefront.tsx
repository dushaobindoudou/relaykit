/**
 * 店面骨架组件 —— 结构照搬源站 zhanghao66.com 的 Tokyo 主题。
 *
 * 用户决策（2026-09-15）：为了老客户的操作熟悉感，店面与源站同款——
 * 品牌差异只保留自有 logo（闸门 A mark + 「代充」），其余骨架
 * （导航、面板、商品表格、收银台）全部按源站的类名与解剖结构来。
 * 视觉基线在 src/styles/tokyo.css（源站主题样式的移植版）。
 *
 * 与源站的有意差异：
 *   - 分类树/商品表直接服务端渲染（源站是 JS 拉取，我们快一拍）
 *   - 语言切换 pill（源站没有；zh-CN 为主，英文可切）
 *   - 源站无站点页脚，我们同样不设页脚
 */

import Link from "next/link";

import { AnnouncementPopup } from "@/components/announcement-popup";
import { BrandMark } from "@/components/brand-mark";
import { LocaleSwitch } from "@/components/locale-switch";
import { NoticeTrigger } from "@/components/notice-trigger";
import type { Announcement } from "@/db/schema";
import type { Dict, Locale } from "@/i18n/dictionary";

export function StoreHeader({
  storeName,
  locale,
  t,
  user,
  supportUrl = null,
  popups = [],
}: {
  storeName: string;
  locale: Locale;
  t: Dict;
  user: { email: string; balance: string } | null;
  /** 客服地址：直接跳转源站客服（配置驱动）。 */
  supportUrl?: string | null;
  /** 公告弹窗数据：非空时导航出现「公告」按钮（源站 tokyo-notice-trigger）。 */
  popups?: Announcement[];
}) {
  return (
    <header className="tokyo-nav-shell">
      <div className="tokyo-nav-wrap">
        <nav className="navbar navbar-expand-xl tokyo-nav">
          <div className="tokyo-brand-wrap">
            <Link className="tokyo-brand" href="/">
              {/* 品牌差异点：mark 与名字都是我们自己的 */}
              <BrandMark size={30} />
              <span className="tokyo-brand-chip">
                <span className="tokyo-brand-name">{storeName}</span>
              </span>
            </Link>
            <button
              className="navbar-toggler tokyo-nav-toggle"
              type="button"
              data-bs-toggle="collapse"
              data-bs-target="#tokyoNavMenu"
              aria-controls="tokyoNavMenu"
              aria-expanded="false"
              aria-label="Toggle navigation"
            >
              <span className="navbar-toggler-icon" />
            </button>
          </div>
          <div className="collapse navbar-collapse" id="tokyoNavMenu">
            <div className="tokyo-nav-main">
              <ul className="navbar-nav tokyo-nav-links">
                <li className="nav-item">
                  <Link className="nav-link tokyo-nav-link is-active" href="/">
                    <i className="fa-duotone fa-regular fa-cart-shopping" aria-hidden />
                    <span>{t.nav.shop}</span>
                  </Link>
                </li>
                <li className="nav-item">
                  <Link className="nav-link tokyo-nav-link" href="/lookup">
                    <i className="fa-duotone fa-regular fa-folders" aria-hidden />
                    <span>{t.nav.findOrder}</span>
                  </Link>
                </li>
                <li className="nav-item">
                  <Link className="nav-link tokyo-nav-link" href="/help">
                    <i className="fa-duotone fa-regular fa-circle-question" aria-hidden />
                    <span>{t.nav.help}</span>
                  </Link>
                </li>
                {supportUrl && (
                  <li className="nav-item">
                    <a
                      className="nav-link tokyo-nav-link"
                      href={supportUrl}
                      target="_blank"
                      rel="noopener"
                    >
                      <i className="fa fa-headphones fa-duotone fa-regular fa-headphones" aria-hidden />
                      <span>{t.nav.contact}</span>
                    </a>
                  </li>
                )}
                {popups.length > 0 && (
                  <li className="nav-item">
                    <NoticeTrigger label={t.nav.notice} />
                  </li>
                )}
              </ul>
              <div className="tokyo-nav-tools">
                <div className="tokyo-auth-actions">
                  {user ? (
                    <Link className="tokyo-button tokyo-button-light" href="/account">
                      <i className="fa-duotone fa-regular fa-user" aria-hidden />
                      <span className="numeric">{user.email.split("@")[0]}</span>
                    </Link>
                  ) : (
                    <>
                      <Link className="tokyo-button tokyo-button-light" href="/account/login">
                        <i className="fa-duotone fa-regular fa-right-to-bracket" aria-hidden />
                        <span>{t.nav.signIn}</span>
                      </Link>
                      <Link className="tokyo-button tokyo-button-dark" href="/account/register">
                        <i className="fa-duotone fa-regular fa-user-plus" aria-hidden />
                        <span>{t.nav.register}</span>
                      </Link>
                    </>
                  )}
                  <LocaleSwitch current={locale} />
                </div>
              </div>
            </div>
          </div>
        </nav>
      </div>
      {/* 公告弹窗（源站 #tokyo-notice-popup）：导航公告按钮可随时重开 */}
      <AnnouncementPopup items={popups} copy={t.noticePopup} />
    </header>
  );
}
