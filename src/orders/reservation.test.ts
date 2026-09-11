/**
 * 预订流程的集成测试：走 createOrder → markPaid → 退款/发货 的完整路径。
 *
 * 状态机允许的迁移在 state.test.ts 里穷举过了；这里验证的是 service 层
 * 「迁移时还要做什么」的那一半 —— 余额、订单标记、自助退款的并发安全。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import {
  createOrder,
  manualFulfill,
  markPaid,
  refundReservationToBalance,
  getOrder,
} from "@/orders/service";
import { createTestContext, seedProduct, seedUser, type TestContext } from "@/testing/context";
import type { Order } from "@/db/schema";

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

afterEach(() => {
  context.close();
});

const BASE = {
  supplierId: "demo",
  code: "HOT-ITEM",
  race: "",
  quantity: 1,
  contactEmail: "guest@example.com",
  queryPassword: "secret",
  chainId: "polygon",
} as const;

describe("预订单生命周期", () => {
  beforeEach(() => {
    // 缺货但可预订的商品。
    seedProduct(context, {
      code: "HOT-ITEM",
      name: "Hot Item",
      stock: 0,
      price: "20",
      cost: "10",
      reservable: true,
    });
  });

  test("缺货可预订：下单成功并打上预订标记", async () => {
    const created = await createOrder(context, { ...BASE });
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.order.reservation, true);
      assert.equal(created.order.status, "awaiting_payment");
    }
  });

  test("到账后进入 reserved 而不是 paid", async () => {
    const created = await createOrder(context, { ...BASE });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await markPaid(context, created.order, "0xhash", "20.01");
    assert.equal(result.ok, true);
    assert.equal(result.status, "reserved");
  });

  test("预订单等不及：自助退到余额（并发双击只入一次账）", async () => {
    const userId = seedUser(context, { balance: "500" });
    const user = {
      id: userId,
      email: "rich@example.com",
      passwordHash: "x",
      balance: "500",
      totalSpent: "0",
      createdAt: new Date().toISOString(),
    };

    const created = await createOrder(context, {
      ...BASE,
      payMethod: "balance",
      user: user as never,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    // 余额支付直接进入预订队列。
    assert.equal(created.order.status, "reserved");

    // 双击退款：两个请求同时到达。
    const results = await Promise.all([
      refundReservationToBalance(context, created.order.id, user as never),
      refundReservationToBalance(context, created.order.id, user as never),
    ]);

    const succeeded = results.filter((r) => r.ok).length;
    assert.equal(succeeded, 1, `双击退款应有且只有一个成功，实际 ${succeeded}`);

    // 余额只入账一次：500 - 订单价 + 一次退款。
    const balance = context.raw
      .prepare("select balance from users where id = ?")
      .get(userId) as { balance: string };
    const paid = Number(created.order.payAmount);
    assert.equal(
      Number(balance.balance),
      500 - paid + paid,
      "退款后的余额应为「扣款后 + 一次退款」，多一次入账即双入账 bug",
    );

    const final = await getOrder(context, created.order.id);
    assert.equal(final?.status, "refunded");
  });

  test("补货后人工发货（manual 模式的交付路径）", async () => {
    const created = await createOrder(context, { ...BASE });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await markPaid(context, created.order as Order, "0xhash", "20.01");

    const done = await manualFulfill(context, created.order.id, "CARD-CODE-123", "使用说明");
    assert.equal(done.ok, true);

    const final = await getOrder(context, created.order.id);
    assert.equal(final?.status, "fulfilled");
    assert.equal(final?.secret, "CARD-CODE-123");
    assert.equal(final?.leaveMessage, "使用说明");
  });

  test("已交付的订单拒绝再次录入卡密", async () => {
    const created = await createOrder(context, { ...BASE });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    await markPaid(context, created.order as Order, "0xhash", "20.01");
    await manualFulfill(context, created.order.id, "FIRST");

    const second = await manualFulfill(context, created.order.id, "SECOND");
    assert.equal(second.ok, false);

    const final = await getOrder(context, created.order.id);
    assert.equal(final?.secret, "FIRST");
  });
});

describe("不可预订的缺货商品", () => {
  test("下单被拒绝，绝不静默放行", async () => {
    seedProduct(context, { code: "PLAIN-OUT", stock: 0, price: "20", cost: "10", reservable: false });

    const created = await createOrder(context, { ...BASE, code: "PLAIN-OUT" });
    assert.equal(created.ok, false);
    if (!created.ok) assert.match(created.error, /库存不足/);
  });
});
