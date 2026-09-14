/**
 * 手动收款渠道（支付宝/微信转账）测试。
 *
 * 核心语义：人工对账的单按**成本口径重算**（30% 而非链上的默认加价），
 * 不分配链上地址与打标金额（watcher 天然不匹配），管理员确认到账后
 * 进入与链上单完全一致的自动采购管线。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import {
  createOrder,
  expireStaleOrders,
  getOrder,
  markPaid,
} from "@/orders/service";
import { manualUnitPrice, convertAmount } from "@/pricing/engine";
import { createTestContext, seedProduct, type TestContext } from "@/testing/context";

const MANUAL_CONFIG = {
  payments: {
    windowMinutes: 30,
    amountTagging: { enabled: true, decimals: 6 },
    chains: [{ id: "polygon", address: "0xTESTADDRESS", confirmations: 1 }],
    manual: {
      enabled: true,
      markupPercent: "30",
      windowHours: 24,
      channels: [
        { id: "alipay", label: "支付宝", account: "shop@example.com" },
        { id: "wechat", label: "微信支付", account: "wechat-id" },
      ],
    },
  },
} as const;

let context: TestContext;

beforeEach(() => {
  context = createTestContext({ config: MANUAL_CONFIG as never });
  // 成本 10 CNY：链上价 = 10×0.1389 + 1（fixed）= 2.39；
  // 手动价 = 10×0.1389×1.3 = 1.8057 → 向上取整 1.81。
  // 供应商 id 刻意不在 suppliers 适配器表里（测试上下文只给 demo 建适配器）：
  // 与 auto-purchase 测试同构，实时库存检查对无适配器供应商跳过，
  // 这里的被测对象是定价与人工确认，不是库存。
  seedProduct(context, {
    supplierId: "manual-sup",
    code: "ITEM",
    race: "",
    name: "Test Item",
    cost: "10",
    price: "20",
  });
});

afterEach(() => {
  context.close();
});

function create(payMethod: string) {
  return createOrder(context, {
    supplierId: "manual-sup",
    code: "ITEM",
    race: "",
    quantity: 1,
    contactEmail: "guest@example.com",
    queryPassword: "pw",
    payMethod,
  });
}

describe("手动收款渠道", () => {
  test("下单：按成本口径 30% 重算价格，不分配链上地址与打标金额", async () => {
    const created = await create("alipay");
    assert.ok(created.ok, JSON.stringify(created));
    const order = created.order;
    assert.equal(order.payMethod, "alipay");
    assert.equal(order.status, "awaiting_payment");
    assert.equal(order.priceTotal, "1.81");
    assert.equal(order.payAmount, null);
    assert.equal(order.payAddress, null);
    assert.equal(order.chainId, null);
    // 付款窗口按 windowHours（24h）而不是链上的 30 分钟。
    const hours = (new Date(order.payWindowEndsAt!).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 23 && hours <= 24, `窗口应约 24 小时，实际 ${hours}`);
  });

  test("未配置的渠道直接拒绝", async () => {
    const created = await create("paypal");
    assert.equal(created.ok, false);
  });

  test("管理员确认到账后进入已付款（自动采购管线接管）", async () => {
    const created = await create("wechat");
    assert.ok(created.ok);
    const paid = await markPaid(
      context,
      created.order,
      "manual:wechat",
      created.order.priceTotal,
    );
    assert.ok(paid.ok, JSON.stringify(paid));
    const order = await getOrder(context, created.order.id);
    assert.equal(order?.status, "paid");
    assert.equal(order?.paidTxHash, "manual:wechat");
  });

  test("未付款的人工单到期后自动关闭（24h 窗口）", async () => {
    const created = await create("alipay");
    assert.ok(created.ok);
    // 把窗口拨到过去，模拟超时。
    const farPast = new Date(Date.now() - 25 * 3_600_000);
    context.raw
      .prepare("update orders set pay_window_ends_at = ? where id = ?")
      .run(farPast.toISOString(), created.order.id);
    const closed = await expireStaleOrders(context);
    assert.equal(closed, 1);
    const order = await getOrder(context, created.order.id);
    assert.equal(order?.status, "expired");
  });
});

describe("手动渠道定价引擎", () => {
  const rates = { CNY_USDT: "0.1389" };
  const rounding = { mode: "up" as const, increment: "0.01" };

  test("成本口径重算 + 阶梯折扣保持形状", () => {
    // 10 CNY × 0.1389 × 1.3 = 1.8057 → 1.81
    const base = manualUnitPrice({
      cost: "10",
      baseRetailPrice: "20",
      tierUnitPrice: "20",
      rates,
      fromCurrency: "CNY",
      toCurrency: "USDT",
      markupPercent: "30",
      rounding,
    });
    assert.equal(base, "1.81");

    // 批发档卖 18（九折）→ 手动价同比例 1.81 × 0.9 = 1.629 → 1.63
    const tiered = manualUnitPrice({
      cost: "10",
      baseRetailPrice: "20",
      tierUnitPrice: "18",
      rates,
      fromCurrency: "CNY",
      toCurrency: "USDT",
      markupPercent: "30",
      rounding,
    });
    assert.equal(tiered, "1.63");
  });

  test("展示金额换算向上取整（USDT → ¥）", () => {
    assert.equal(convertAmount("1.811", rates, "USDT", "CNY"), "13.04");
  });
});
