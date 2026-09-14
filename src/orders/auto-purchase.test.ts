/**
 * 自动中转采购集成测试：游客下单 → 热钱包付款 → 到账轮询 → 收卡交付。
 *
 * 全链路打在本仓库的 MockUpstream 游客面上（复刻 acg-faka 前台契约），
 * 出款用注入的假执行器 —— 这里验证的是编排与状态机接线，不是签名本身。
 * 亏损路径（护栏、缺私钥、过期重下、付了款上游过期）逐条覆盖。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import {
  createOrder,
  fulfillOrder,
  getOrder,
  markPaid,
} from "@/orders/service";
import { settleUpstreamPurchases, type DisbursementExecutor } from "@/orders/auto-purchase";
import {
  MockUpstream,
  MOCK_CNY_USDT_RATE,
  MOCK_USDT_ADDRESS,
  MOCK_USDT_CHAIN_LABEL,
  type MockGuestItem,
} from "@/supplier/acgfaka/mock-upstream";
import { createTestContext, seedProduct, type TestContext } from "@/testing/context";
import type { Order } from "@/db/schema";

const ITEM: MockGuestItem = {
  itemId: "220",
  name: "Test Guest Item",
  race: "实体卡接码",
  unitPriceCny: "5",
  stock: 100,
  confirmStatus: 1,
};

let mock: MockUpstream;
let mockUrl: string;
let context: TestContext;
let order: Order;

/** 假出款器：不碰链，直接返回固定哈希。 */
const fakeExecutor: DisbursementExecutor = async (input) => ({
  txHash: `0xfake-${input.to.slice(-4)}-${input.amountUsdt}`,
  amountUnits: "0",
});

/** 永远出款失败的假执行器（测过期重下时保持"没付出去"状态）。 */
const failingExecutor: DisbursementExecutor = async () => {
  throw new Error("rpc down");
};

const cleanups: (() => void)[] = [];

async function setup(test: {
  maxPayUsdt?: string;
  minBatchCny?: string;
  executor?: DisbursementExecutor;
  withWalletKey?: boolean;
}): Promise<void> {
  mock = new MockUpstream({
    appId: "test-app",
    appKey: "test-key",
    products: [],
  });
  mock.setGuestItems([ITEM]);
  mockUrl = await mock.start();

  context = createTestContext({
    config: {
      suppliers: [
        {
          id: "upstream",
          driver: "acgfaka-public",
          domain: mockUrl,
          currency: "CNY",
          timeoutMs: 20000,
          costBasis: "retail",
          autoPurchase: {
            enabled: true,
            contact: "relay@test.local",
            payChannelId: 6,
            maxPayUsdt: test.maxPayUsdt ?? "30",
            minBatchCny: test.minBatchCny ?? "25",
          },
        },
      ],
    },
  });
  if (test.withWalletKey ?? true) {
    context.secrets.payoutWalletKey = "0xtest-key";
  }
  if (test.executor) {
    const restore = await import("@/orders/auto-purchase").then(
      (m) => m.setDisbursementExecutor(test.executor!),
    );
    cleanups.push(restore);
  }

  seedProduct(context, {
    supplierId: "upstream",
    code: "220",
    race: "实体卡接码",
    name: ITEM.name,
    cost: "5",
    price: "6",
  });

  const created = await createOrder(context, {
    supplierId: "upstream",
    code: "220",
    race: "实体卡接码",
    quantity: 1,
    contactEmail: "customer@example.com",
    queryPassword: "",
    chainId: "polygon",
  });
  assert.ok(created.ok);
  order = created.order as Order;
  const paid = await markPaid(context, order, "0xcustomer-tx", "6.00");
  assert.ok(paid.ok, JSON.stringify(paid));
  order = (await getOrder(context, order.id)) as Order;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn();
  context.close();
  await mock.stop();
});

describe("自动中转采购", () => {
  test("收款确认后：凑单下单、解析收银台、记录上游凭据", async () => {
    await setup({ executor: fakeExecutor });

    const result = await fulfillOrder(context, order);
    assert.equal(result.ok, true);
    assert.equal(result.status, "procuring");

    const updated = (await getOrder(context, order.id)) as Order;
    assert.match(updated.upstreamTradeNo ?? "", /^GUEST\d{9}$/);
    // 凑单：单件 5 元、门槛 25 元 → 上游买 5 件（客户只买 1 件）
    assert.equal(updated.upstreamPayAmount, (25 / MOCK_CNY_USDT_RATE).toFixed(3));
    assert.equal(updated.upstreamPayAddress, MOCK_USDT_ADDRESS);
    assert.equal(updated.upstreamPayChain, MOCK_USDT_CHAIN_LABEL);
    assert.equal(updated.upstreamContact, "relay@test.local");
    assert.equal(updated.upstreamAttempt, 1);
    assert.equal(mock.guestTradeNos.length, 1);
  });

  test("付款并到账后：自动收卡交付", async () => {
    await setup({ executor: fakeExecutor });

    await fulfillOrder(context, order);
    let updated = (await getOrder(context, order.id)) as Order;
    const tradeNo = updated.upstreamTradeNo!;

    // 第一轮结算：出款。
    const first = await settleUpstreamPurchases(context);
    assert.equal(first.handled, 1);
    updated = (await getOrder(context, order.id)) as Order;
    assert.match(updated.upstreamPaidTxHash ?? "", /^0xfake-/);
    assert.equal(updated.status, "procuring");

    // 第二轮结算前：模拟链上到账（上游自动发货）。
    mock.payGuestOrder(tradeNo);
    const second = await settleUpstreamPurchases(context);
    assert.equal(second.delivered, 1);

    updated = (await getOrder(context, order.id)) as Order;
    assert.equal(updated.status, "fulfilled");
    assert.equal(updated.secret, `GUEST-SECRET-${tradeNo}`);
    assert.equal(updated.leaveMessage, "guest-leave-message");
  });

  test("应付金额超护栏：转人工且不付款", async () => {
    await setup({ executor: fakeExecutor, maxPayUsdt: "1" });

    await fulfillOrder(context, order);
    const result = await settleUpstreamPurchases(context);
    assert.equal(result.flagged, 1);

    const updated = (await getOrder(context, order.id)) as Order;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.upstreamPaidTxHash, null);
    assert.match(updated.reviewReason ?? "", /护栏/);
  });

  test("未配置热钱包私钥：转人工且不付款", async () => {
    await setup({ executor: fakeExecutor, withWalletKey: false });

    await fulfillOrder(context, order);
    await settleUpstreamPurchases(context);

    const updated = (await getOrder(context, order.id)) as Order;
    assert.equal(updated.status, "needs_review");
    assert.equal(updated.upstreamPaidTxHash, null);
    assert.match(updated.reviewReason ?? "", /热钱包私钥/);
  });

  test("上游订单过期且未付款：自动重新下单", async () => {
    await setup({ executor: failingExecutor });

    await fulfillOrder(context, order);
    const first = (await getOrder(context, order.id)) as Order;
    const expiredTradeNo = first.upstreamTradeNo!;

    // 过期后：出款器一直失败（没付出去）→ query 正常但 status 0、
    // index/query 查不到（过期清理）→ 重新下单。
    mock.expireGuestOrder(expiredTradeNo);
    await settleUpstreamPurchases(context);

    const updated = (await getOrder(context, order.id)) as Order;
    assert.equal(updated.upstreamAttempt, 2);
    assert.ok(updated.upstreamTradeNo);
    assert.notEqual(updated.upstreamTradeNo, expiredTradeNo);
    assert.equal(updated.status, "procuring");
  });

  test("已付款但上游过期清理：转人工对账", async () => {
    await setup({ executor: fakeExecutor });

    await fulfillOrder(context, order);
    const first = (await getOrder(context, order.id)) as Order;
    await settleUpstreamPurchases(context);
    mock.payGuestOrder(first.upstreamTradeNo!);
    mock.expireGuestOrder(first.upstreamTradeNo!);
    mock.guestFaults.guestQueryAlwaysFail = true;

    const result = await settleUpstreamPurchases(context);
    assert.equal(result.handled, 1);

    const updated = (await getOrder(context, order.id)) as Order;
    assert.equal(updated.status, "needs_review");
    assert.ok(updated.upstreamPaidTxHash);
  });

  test("上游缺货：拒绝并进入待退款", async () => {
    await setup({});
    mock.guestFaults.guestTradeRejectWith = "库存不足";
    // 首次下单就会遇到拒绝 → procurement_rejected。
    const result = await fulfillOrder(context, order);
    assert.equal(result.ok, false);

    const updated = (await getOrder(context, order.id)) as Order;
    assert.equal(updated.status, "procurement_failed");
    assert.equal(mock.guestTradeNos.length, 0);
  });
});
