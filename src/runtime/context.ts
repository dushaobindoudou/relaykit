/**
 * 运行时上下文：把「配置 + 数据库 + 上游适配器」组装成一个对象。
 *
 * Workers 每次请求都是新实例，没有可以常驻的单例；而同一次请求内重复解析
 * 配置、重复构造适配器又是纯浪费。折中：按请求缓存，绑定对象作为缓存键。
 */

import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { generatedRawConfig } from "@/config/generated";
import { loadConfig, type EnvSource } from "@/config/load";
import type { BuyRelayConfig } from "@/config/schema";
import * as schema from "@/db/schema";
import { createSuppliers } from "@/supplier/factory";
import type { SupplierAdapter } from "@/supplier/types";

/**
 * Cloudflare 绑定。类型由 `wrangler types` 从 wrangler.jsonc 生成，
 * 密钥在 src/types/env.d.ts 里补充声明。
 */
export type Bindings = CloudflareEnv;

export interface BuyRelaySecrets {
  /** 自动采购热钱包私钥。空 = 自动付款关闭，一律转人工。 */
  payoutWalletKey?: string;
  /** WAF 中继共享密钥。 */
  relaySecret?: string;
}

export interface BuyRelayContext {
  config: BuyRelayConfig;
  db: DrizzleD1Database<typeof schema>;
  suppliers: Map<string, SupplierAdapter>;
  /** 出款/中继等资金相关密钥的窄视图。别把整个 env 挂进上下文。 */
  secrets: BuyRelaySecrets;
}

const cache = new WeakMap<object, BuyRelayContext>();

/**
 * 配置解析失败时不抛异常，而是把错误带出来。
 *
 * 理由：配置错了正是最需要诊断页面能打开的时候。直接抛会让整站白屏，
 * 使用者只能去翻 Workers 日志 —— 对自托管的人来说这体验太差了。
 */
export interface ContextResult {
  ok: boolean;
  context?: BuyRelayContext;
  error?: string;
}

export function buildContext(env: Bindings): ContextResult {
  const cached = cache.get(env);
  if (cached) return { ok: true, context: cached };

  let config: BuyRelayConfig;
  try {
    config = loadConfig({
      raw: structuredClone(generatedRawConfig),
      // Workers 的密钥来自 env 绑定而非 process.env。绑定对象是具名接口，
      // 而插值需要按字符串键随意索引，这里的两级转换是必要的。
      env: env as unknown as EnvSource,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!env.DB) {
    return {
      ok: false,
      error:
        "缺少 D1 绑定 DB。请确认 wrangler.jsonc 里的 d1_databases 配置正确，" +
        "并已执行 `wrangler d1 migrations apply relaykit --remote`。",
    };
  }

  const context: BuyRelayContext = {
    config,
    db: drizzle(env.DB, { schema }),
    suppliers: createSuppliers(config.suppliers),
    secrets: {
      ...(env.PAYOUT_WALLET_KEY ? { payoutWalletKey: env.PAYOUT_WALLET_KEY } : {}),
      ...(env.RELAY_SECRET ? { relaySecret: env.RELAY_SECRET } : {}),
    },
  };

  cache.set(env, context);
  return { ok: true, context };
}
