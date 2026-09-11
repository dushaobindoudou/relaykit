/**
 * 店铺元信息的只读视图。
 *
 * 布局与元数据需要店名、币种这些配置，但它们不应为此背上整个运行时上下文
 * （数据库连接、上游适配器）—— 配置坏掉时元数据仍要能渲染出可读的页面，
 * 否则使用者看到的是白屏而不是「配置哪里错了」。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { generatedRawConfig } from "@/config/generated";
import { loadConfig, type EnvSource } from "@/config/load";

export interface StoreMeta {
  name: string;
  description: string;
  currency: string;
  locale: string;
  baseUrl: string | null;
  supportEmail: string | null;
  /** 在线客服地址（Crisp/Tawk/自建）。挂在全站右下角浮窗，空则不渲染。 */
  supportUrl: string | null;
}

const FALLBACK: StoreMeta = {
  name: "Store",
  description: "Digital goods, delivered instantly.",
  currency: "USDT",
  locale: "en",
  baseUrl: null,
  supportEmail: null,
  supportUrl: null,
};

export async function getStoreMeta(): Promise<StoreMeta> {
  try {
    const { env } = getCloudflareContext();
    const config = loadConfig({
      raw: structuredClone(generatedRawConfig),
      env: env as unknown as EnvSource,
    });

    return {
      name: config.store.name,
      description: `${config.store.name}. Digital goods delivered instantly, paid in ${config.store.currency}.`,
      currency: config.store.currency,
      locale: config.store.locale,
      baseUrl: config.store.baseUrl,
      supportEmail: config.store.supportEmail ?? null,
      supportUrl: config.store.supportUrl ?? null,
    };
  } catch {
    // 配置无效时仍返回可用的兜底，让页面能渲染出错误说明。
    return FALLBACK;
  }
}
