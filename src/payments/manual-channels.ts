/**
 * 人工收款渠道 —— 运营态覆盖层。
 *
 * 配置文件里的 payments.manual 是初始值；后台（/admin）保存的
 * 渠道存在 D1 settings 表（key = manual_channels），读取时覆盖配置：
 * 这样店主上传收款码/改账号不需要改配置、重新部署。
 *
 * 覆盖语义：只替换 channels 数组（含每个渠道的启用位），
 * enabled/markupPercent/windowHours 仍来自配置文件。
 * 没有任何覆盖行时原样用配置 —— 未初始化的部署行为不变。
 */

import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import * as schema from "@/db/schema";
import { settings } from "@/db/schema";
import type { BuyRelayConfig } from "@/config/schema";

export const MANUAL_CHANNELS_KEY = "manual_channels";

/** 单个收款码 data URI 的上限（≈300KB 原图）。收款码用不着更大。 */
const MAX_QR_DATA_URI = 400_000;

export const storedChannelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "渠道 id 只允许小写字母、数字和连字符"),
  label: z.string().min(1).max(40),
  /** 收款账号（手机号/邮箱/微信号）。留空表示该渠道暂不可用。 */
  account: z.string().max(120).default(""),
  /** 收款码图片 data URI（后台上传，前端 canvas 压缩过）。 */
  qrImage: z.string().max(MAX_QR_DATA_URI).optional(),
  /** 转账说明（如"转账请备注订单号"）。 */
  instructions: z.string().max(200).optional(),
  /** 关闭的渠道不进结账表单，也不进订单页。 */
  enabled: z.boolean().default(true),
});

export const storedChannelsSchema = z.object({
  channels: z.array(storedChannelSchema).max(6),
});

export type StoredChannel = z.infer<typeof storedChannelSchema>;

/** 读覆盖（无覆盖时返回 null）。损坏的 JSON 视为未设置 —— 不让一个坏行拖垮结账。 */
export async function loadManualOverrides(
  db: DrizzleD1Database<typeof schema>,
): Promise<StoredChannel[] | null> {
  try {
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, MANUAL_CHANNELS_KEY))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const parsed = storedChannelsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data.channels : null;
  } catch {
    return null;
  }
}

/** 保存覆盖。传空数组 = 关闭全部人工渠道。 */
export async function saveManualOverrides(
  db: DrizzleD1Database<typeof schema>,
  channels: StoredChannel[],
  now = new Date().toISOString(),
): Promise<void> {
  const payload = storedChannelsSchema.parse({ channels });
  await db
    .insert(settings)
    .values({
      key: MANUAL_CHANNELS_KEY,
      value: JSON.stringify(payload),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(payload), updatedAt: now },
    });
}

/** 合并后的 manual 段（覆盖存在时替换 channels）；没有可用渠道时返回 null。 */
export function resolveManualConfig(
  config: BuyRelayConfig,
  overrides: StoredChannel[] | null,
): BuyRelayConfig["payments"]["manual"] | null {
  const base = config.payments.manual;
  if (!base) return null;
  const source = overrides ?? base.channels.map((item) => ({ ...item, enabled: true }));
  // 关闭位与空账号的渠道都不进结账：展示一个没法收款的渠道只会制造废单。
  const channels = source
    .filter((item) => item.enabled && item.account.trim() !== "")
    .map((item) => ({
      id: item.id,
      label: item.label,
      account: item.account.trim(),
      ...(item.qrImage ? { qrImage: item.qrImage } : {}),
      ...(item.instructions ? { instructions: item.instructions } : {}),
    }));
  if (channels.length === 0) return null;
  return { ...base, enabled: true, channels };
}
