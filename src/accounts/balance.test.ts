/**
 * 余额账本测试。
 *
 * 余额是客户真金白银换来的，任何一次错记都是直接的财务损失。
 * 这些用例盯的是三件事：不能透支、每次变动必有流水、并发下不会双花。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import * as ledger from "./balance";
import { createTestContext, seedUser, type TestContext } from "@/testing/context";

let context: TestContext;
let userId: string;

beforeEach(() => {
  context = createTestContext();
  userId = seedUser(context, { balance: "100.00" });
});

afterEach(() => context.close());

describe("记账", () => {
  test("充值增加余额并写流水", async () => {
    const result = await ledger.post(context, {
      userId,
      kind: "topup",
      amount: "50.00",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.balanceAfter, "150.00");

    const rows = await ledger.listTransactions(context, userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "topup");
    assert.equal(rows[0]?.balanceAfter, "150.00");
  });

  test("消费减少余额，金额为负", async () => {
    const result = await ledger.post(context, {
      userId,
      kind: "spend",
      amount: "-30.00",
    });

    assert.equal(result.ok && result.balanceAfter, "70.00");
  });

  test("每一次变动都留下流水 —— 没有流水的余额查不清账", async () => {
    await ledger.post(context, { userId, kind: "topup", amount: "10" });
    await ledger.post(context, { userId, kind: "spend", amount: "-5" });
    await ledger.post(context, { userId, kind: "refund", amount: "5" });

    const rows = await ledger.listTransactions(context, userId);
    assert.equal(rows.length, 3);
    // 每条都记了变动后的余额，可以逐笔核验。
    assert.deepEqual(
      rows.map((row) => row.balanceAfter).sort(),
      ["105.00", "110.00", "110.00"].sort(),
    );
  });
});

describe("不允许透支", () => {
  test("余额不足时拒绝扣款，且余额不变", async () => {
    const result = await ledger.post(context, {
      userId,
      kind: "spend",
      amount: "-200.00",
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, "insufficient_funds");

    // 关键：失败必须是**完全没有副作用**的，余额和流水都不能动。
    const rows = await ledger.listTransactions(context, userId);
    assert.equal(rows.length, 0);
  });

  test("刚好扣完允许（边界不应误杀）", async () => {
    const result = await ledger.post(context, {
      userId,
      kind: "spend",
      amount: "-100.00",
    });
    assert.equal(result.ok && result.balanceAfter, "0.00");
  });

  test("用户不存在时拒绝而不是凭空创建", async () => {
    const result = await ledger.post(context, {
      userId: "ghost",
      kind: "topup",
      amount: "10",
    });
    assert.equal(result.ok === false && result.error, "user_not_found");
  });
});

describe("并发", () => {
  test("条件更新挡住双花：两笔并发扣款只有一笔能成", async () => {
    // 余额 100，两笔各扣 80。若没有条件更新，两笔都会读到 100 然后各自写回 20，
    // 结果是花了 160 却只扣了 80 —— 这正是双花。
    const [first, second] = await Promise.all([
      ledger.post(context, { userId, kind: "spend", amount: "-80.00" }),
      ledger.post(context, { userId, kind: "spend", amount: "-80.00" }),
    ]);

    const succeeded = [first, second].filter((result) => result.ok);
    assert.equal(succeeded.length, 1, "只应有一笔成功");

    const failed = [first, second].find((result) => !result.ok);
    assert.ok(
      failed && !failed.ok && ["concurrent_update", "insufficient_funds"].includes(failed.error),
    );

    const rows = await ledger.listTransactions(context, userId);
    assert.equal(rows.length, 1, "失败的那笔不能留下流水");
    assert.equal(rows[0]?.balanceAfter, "20.00");
  });

  test("postWithRetry 在并发冲突后重试成功", async () => {
    await Promise.all([
      ledger.postWithRetry(context, { userId, kind: "topup", amount: "10" }),
      ledger.postWithRetry(context, { userId, kind: "topup", amount: "10" }),
      ledger.postWithRetry(context, { userId, kind: "topup", amount: "10" }),
    ]);

    const rows = await ledger.listTransactions(context, userId);
    assert.equal(rows.length, 3, "三笔充值都应最终成功");
  });

  test("余额不足不会被重试掩盖 —— 重试多少次都还是不足", async () => {
    const result = await ledger.postWithRetry(context, {
      userId,
      kind: "spend",
      amount: "-500",
    });
    assert.equal(result.ok === false && result.error, "insufficient_funds");
  });
});

describe("累计消费额", () => {
  test("只有 spend 计入，退款不倒扣（这是历史贡献口径，不是净额）", async () => {
    await ledger.post(context, { userId, kind: "spend", amount: "-40" });
    await ledger.post(context, { userId, kind: "refund", amount: "40" });

    const rows = context.raw
      .prepare("select total_spent from users where id = ?")
      .get(userId) as { total_spent: string };

    assert.equal(rows.total_spent, "40.00");
  });
});

describe("精度", () => {
  test("小数累加不出现浮点误差", async () => {
    const fresh = seedUser(context, { balance: "0" });
    for (let i = 0; i < 10; i += 1) {
      await ledger.post(context, { userId: fresh, kind: "topup", amount: "0.10" });
    }

    const row = context.raw
      .prepare("select balance from users where id = ?")
      .get(fresh) as { balance: string };

    // 用 number 累加 10 次 0.1 会得到 0.9999999999999999。
    assert.equal(row.balance, "1.00");
  });
});
