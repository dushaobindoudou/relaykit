/**
 * 余额充值。
 *
 * 与商品订单共用同一套链上收款机制（唯一金额打标），但结果不是发卡密，
 * 而是给余额加钱。单独成一条链路是因为它没有商品、没有上游进货 ——
 * 硬塞进订单表会让订单的每个字段都要处理「充值单没有商品」这种例外。
 */

import { and, eq, sql } from "drizzle-orm";

import * as ledger from "@/accounts/balance";
import { isPlaceholderAddress } from "@/config/schema";
import { tagAmount } from "@/payments/tagging";
import { topups, type Topup, type User } from "@/db/schema";
import type { RelayKitContext } from "@/runtime/context";

export type CreateTopupResult =
  | { ok: true; topup: Topup }
  | { ok: false; error: string };

function newTopupId(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `T${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export async function createTopup(
  context: RelayKitContext,
  user: User,
  amount: string,
  chainId: string,
): Promise<CreateTopupResult> {
  const { config } = context;

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "充值金额不合法" };
  }
  // 上限不是怕收太多，而是把手滑输入的 10000 挡在外面。
  if (value > 100_000) return { ok: false, error: "单次充值金额过大" };

  const chain = config.payments.chains.find(
    (item) => item.id === chainId && item.enabled,
  );
  if (!chain) return { ok: false, error: "该收款方式不可用" };
  if (isPlaceholderAddress(chain.address)) {
    return { ok: false, error: "该收款方式尚未配置完成" };
  }

  const decimals = config.payments.amountTagging.enabled
    ? config.payments.amountTagging.decimals
    : 2;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + config.payments.windowMinutes * 60_000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = {
      id: newTopupId(),
      userId: user.id,
      status: "awaiting_payment" as const,
      amount: value.toFixed(2),
      chainId: chain.id,
      payAddress: chain.address,
      // 尾数只占价格精度之后的位，多收永远小于一分钱。见 payments/tagging。
      payAmount: tagAmount(value.toFixed(2), decimals),
      payWindowEndsAt: windowEnd.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await context.db.insert(topups).values(row);
      return { ok: true, topup: row as Topup };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE|constraint/i.test(message)) {
        return { ok: false, error: `创建充值单失败：${message}` };
      }
    }
  }

  return { ok: false, error: "暂时分配不出唯一收款金额，请稍后重试" };
}

/**
 * 确认充值到账。由链上收款监听调用。
 *
 * 先把状态推到 credited 再加余额：条件更新保证同一张充值单只会被
 * 入账一次，即便监听器重复投递同一笔转账。顺序反过来的话，
 * 重复投递会重复加钱。
 */
export async function creditTopup(
  context: RelayKitContext,
  topup: Topup,
  txHash: string,
): Promise<{ ok: boolean; reason?: string }> {
  const claimed = await context.db
    .update(topups)
    .set({
      status: "credited",
      paidTxHash: txHash,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(topups.id, topup.id), eq(topups.status, "awaiting_payment")))
    .returning({ id: topups.id });

  if (claimed.length === 0) return { ok: false, reason: "already_credited" };

  const result = await ledger.postWithRetry(context, {
    userId: topup.userId,
    kind: "topup",
    amount: topup.amount,
    note: `Top-up ${topup.id}`,
  });

  if (!result.ok) {
    // 状态已经改成 credited 但钱没加上 —— 这是必须人工介入的状态，
    // 绝不能把状态改回去（那会让重复投递再次尝试入账）。
    return { ok: false, reason: `ledger_failed:${result.error}` };
  }

  return { ok: true };
}

export async function expireStaleTopups(
  context: RelayKitContext,
  now = new Date(),
): Promise<number> {
  const result = await context.db
    .update(topups)
    .set({ status: "expired", updatedAt: now.toISOString() })
    .where(
      and(
        eq(topups.status, "awaiting_payment"),
        sql`${topups.payWindowEndsAt} < ${now.toISOString()}`,
      ),
    )
    .returning({ id: topups.id });

  return result.length;
}

export async function getTopup(
  context: RelayKitContext,
  id: string,
): Promise<Topup | null> {
  const rows = await context.db.select().from(topups).where(eq(topups.id, id)).limit(1);
  return rows[0] ?? null;
}
