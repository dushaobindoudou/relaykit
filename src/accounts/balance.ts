/**
 * 余额账本。
 *
 * 一条铁律：**余额只能通过这里的函数变动，且每次变动必须写流水**。
 * 直接 UPDATE users.balance 的代码一旦出现，账就永远查不清了 ——
 * 客户说少了十块钱，你拿不出任何证据。
 */

import { Decimal } from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { balanceTransactions, users } from "@/db/schema";
import type { DaichongContext } from "@/runtime/context";

export type LedgerKind = "topup" | "spend" | "refund" | "adjust";

export interface LedgerEntry {
  userId: string;
  kind: LedgerKind;
  /** 带符号：充值为正，消费为负。 */
  amount: string;
  orderId?: string;
  note?: string;
}

export type LedgerResult =
  | { ok: true; balanceAfter: string }
  | { ok: false; error: "insufficient_funds" | "concurrent_update" | "user_not_found" };

/**
 * 记一笔余额变动。
 *
 * 并发安全靠**带原值的条件更新**：读到余额 X，更新时要求 `balance = X`。
 * 两个请求同时扣款时只有一个能匹配到行，另一个更新 0 行并得到
 * concurrent_update，由调用方重试。D1 没有可用的行级锁与交互式事务，
 * 这是这个平台上唯一可靠的做法。
 */
export async function post(
  context: DaichongContext,
  entry: LedgerEntry,
): Promise<LedgerResult> {
  const rows = await context.db
    .select()
    .from(users)
    .where(eq(users.id, entry.userId))
    .limit(1);

  const user = rows[0];
  if (!user) return { ok: false, error: "user_not_found" };

  const current = new Decimal(user.balance);
  const delta = new Decimal(entry.amount);
  const next = current.plus(delta);

  // 余额不允许为负。允许透支意味着我们在无担保地给陌生人放贷。
  if (next.isNegative()) return { ok: false, error: "insufficient_funds" };

  const now = new Date().toISOString();
  const nextBalance = next.toFixed(2);

  const updated = await context.db
    .update(users)
    .set({
      balance: nextBalance,
      // 消费才计入累计消费额，退款不倒扣 —— 累计消费是用于会员等级的
      // 「历史贡献」口径，不是净额。
      ...(entry.kind === "spend"
        ? { totalSpent: new Decimal(user.totalSpent).plus(delta.abs()).toFixed(2) }
        : {}),
    })
    .where(and(eq(users.id, entry.userId), eq(users.balance, user.balance)))
    .returning({ id: users.id });

  if (updated.length === 0) return { ok: false, error: "concurrent_update" };

  await context.db.insert(balanceTransactions).values({
    userId: entry.userId,
    kind: entry.kind,
    amount: delta.toFixed(2),
    balanceAfter: nextBalance,
    orderId: entry.orderId ?? null,
    note: entry.note ?? null,
    createdAt: now,
  });

  return { ok: true, balanceAfter: nextBalance };
}

/** 带重试的记账。并发冲突是正常现象，不该让用户看到错误。 */
export async function postWithRetry(
  context: DaichongContext,
  entry: LedgerEntry,
  attempts = 4,
): Promise<LedgerResult> {
  let last: LedgerResult = { ok: false, error: "concurrent_update" };

  for (let i = 0; i < attempts; i += 1) {
    last = await post(context, entry);
    // 只有并发冲突值得重试；余额不足重试多少次都是不足。
    if (last.ok || last.error !== "concurrent_update") return last;
  }

  return last;
}

export async function listTransactions(
  context: DaichongContext,
  userId: string,
  limit = 50,
) {
  return context.db
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId))
    .orderBy(sql`${balanceTransactions.createdAt} desc`)
    .limit(limit);
}
