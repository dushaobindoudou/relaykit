/**
 * 订单状态机测试。
 *
 * 除了逐条验证允许的迁移，这里还做了一件更重要的事：**穷举所有
 * (状态 × 事件) 组合**，断言没有任何一条组合会把已付款的订单带向作废，
 * 也没有任何一条会允许重复进货。这两类 bug 直接对应真金白银的损失，
 * 靠挑几个用例覆盖不住。
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  canRevealSecret,
  isTerminal,
  needsAttention,
  owesRefund,
  transition,
  type OrderEvent,
  type OrderStatus,
} from "./state";

const ALL_STATUSES: OrderStatus[] = [
  "draft",
  "awaiting_payment",
  "paid",
  "procuring",
  "fulfilled",
  "procurement_failed",
  "refunded",
  "needs_review",
  "expired",
];

const ALL_EVENTS: OrderEvent[] = [
  { type: "payment_requested" },
  { type: "payment_confirmed", txHash: "0xtx", amount: "5.17" },
  { type: "payment_window_elapsed" },
  { type: "procurement_started" },
  { type: "procurement_succeeded", supplierTradeNo: "T1", secret: "CODE" },
  { type: "procurement_rejected", reason: "库存不足" },
  { type: "procurement_ambiguous", reason: "超时" },
  { type: "refund_completed" },
  { type: "flagged_for_review", reason: "客户申诉" },
];

/** 走完整条happy path，返回沿途状态，供其它用例复用。 */
function happyPath(): OrderStatus {
  let status: OrderStatus = "draft";
  for (const event of [
    { type: "payment_requested" } as const,
    { type: "payment_confirmed", txHash: "0x", amount: "1" } as const,
    { type: "procurement_started" } as const,
    { type: "procurement_succeeded", supplierTradeNo: "T", secret: "S" } as const,
  ]) {
    const result = transition(status, event);
    assert.equal(result.ok, true, `${status} + ${event.type} 应当允许`);
    if (result.ok) status = result.next;
  }
  return status;
}

describe("正常路径", () => {
  test("draft → awaiting_payment → paid → procuring → fulfilled", () => {
    assert.equal(happyPath(), "fulfilled");
  });

  test("只有 fulfilled 能给客户看卡密", () => {
    for (const status of ALL_STATUSES) {
      assert.equal(canRevealSecret(status), status === "fulfilled");
    }
  });
});

describe("核心不变式：已付款的订单不会被作废", () => {
  // 这是整个文件里最重要的一条。支付窗口定时器与链上确认是两个独立时钟，
  // 客户卡着窗口末尾付款必然会撞上；只要漏一次，那笔钱就成了黑账。
  test("paid / procuring 收到超时事件时拒绝迁移", () => {
    for (const status of ["paid", "procuring"] as const) {
      const result = transition(status, { type: "payment_window_elapsed" });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.benign, true);
    }
  });

  test("穷举：没有任何事件能把付款后的状态带到 expired", () => {
    const afterPayment: OrderStatus[] = [
      "paid",
      "procuring",
      "fulfilled",
      "procurement_failed",
      "refunded",
      "needs_review",
    ];

    for (const status of afterPayment) {
      for (const event of ALL_EVENTS) {
        const result = transition(status, event);
        if (result.ok) {
          assert.notEqual(
            result.next,
            "expired",
            `${status} + ${event.type} 把已付款订单带向了 expired`,
          );
        }
      }
    }
  });
});

describe("核心不变式：不会重复向上游进货", () => {
  test("procuring 状态拒绝再次发起进货，且不标记为良性", () => {
    const result = transition("procuring", { type: "procurement_started" });
    assert.equal(result.ok, false);
    // 非良性：并发抢单意味着调度有问题，要告警而不是静默吞掉。
    assert.equal(result.ok === false && result.benign, false);
  });

  test("穷举：只有 paid 能进入 procuring", () => {
    for (const status of ALL_STATUSES) {
      const result = transition(status, { type: "procurement_started" });
      if (result.ok) {
        assert.equal(status, "paid", `${status} 不应能进入 procuring`);
      }
    }
  });
});

describe("链上回调重放是常态，必须良性忽略", () => {
  test("已付款后重复收到到账事件被忽略而非报警", () => {
    for (const status of ["paid", "procuring"] as const) {
      const result = transition(status, {
        type: "payment_confirmed",
        txHash: "0x",
        amount: "1",
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.benign, true);
    }
  });

  test("重复分配收款信息被忽略（客户刷新页面）", () => {
    const result = transition("awaiting_payment", { type: "payment_requested" });
    assert.equal(result.ok === false && result.benign, true);
  });

  test("fulfilled 收到重复的进货成功事件属良性", () => {
    const result = transition("fulfilled", {
      type: "procurement_succeeded",
      supplierTradeNo: "T",
      secret: "S",
    });
    assert.equal(result.ok === false && result.benign, true);
  });
});

describe("异常入账必须告警而不是放行", () => {
  test("尚未分配收款信息就到账 → 非良性拒绝（金额打标撞号的信号）", () => {
    const result = transition("draft", {
      type: "payment_confirmed",
      txHash: "0x",
      amount: "1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.benign, false);
  });

  test("已过期的订单收到到账 → 非良性拒绝（客户迟付，需人工决定退还是补发）", () => {
    const result = transition("expired", {
      type: "payment_confirmed",
      txHash: "0x",
      amount: "1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.benign, false);
  });
});

describe("进货失败的两种结局要分开处理", () => {
  test("明确拒绝 → procurement_failed（钱没扣，可安全退款）", () => {
    const result = transition("procuring", {
      type: "procurement_rejected",
      reason: "库存不足",
    });
    assert.equal(result.ok && result.next, "procurement_failed");
    assert.equal(owesRefund("procurement_failed"), true);
  });

  test("不确定 → needs_review（可能已扣款，绝不自动退款）", () => {
    const result = transition("procuring", {
      type: "procurement_ambiguous",
      reason: "超时",
    });
    assert.equal(result.ok && result.next, "needs_review");
    // 关键：needs_review **不**被视为"欠客户退款"，否则自动退款任务
    // 会把这笔既赔货又赔钱的单子推下去。
    assert.equal(owesRefund("needs_review"), false);
    assert.equal(needsAttention("needs_review"), true);
  });

  test("needs_review 允许人工补录卡密收尾（上游捞回来的情况）", () => {
    const result = transition("needs_review", {
      type: "procurement_succeeded",
      supplierTradeNo: "T",
      secret: "S",
    });
    assert.equal(result.ok && result.next, "fulfilled");
  });

  test("needs_review 也允许人工判定后退款", () => {
    const result = transition("needs_review", { type: "refund_completed" });
    assert.equal(result.ok && result.next, "refunded");
  });
});

describe("终态", () => {
  test("三个终态不再接受任何非良性迁移", () => {
    for (const status of ["fulfilled", "refunded", "expired"] as const) {
      assert.equal(isTerminal(status), true);
      for (const event of ALL_EVENTS) {
        assert.equal(
          transition(status, event).ok,
          false,
          `${status} 不应接受 ${event.type}`,
        );
      }
    }
  });
});

describe("人工兜底闸门", () => {
  test("任何非终态订单都能被挑进人工队列", () => {
    for (const status of ALL_STATUSES) {
      const result = transition(status, {
        type: "flagged_for_review",
        reason: "客户申诉",
      });
      if (isTerminal(status) || status === "needs_review") {
        assert.equal(result.ok, false);
      } else {
        assert.equal(result.ok && result.next, "needs_review", `${status} 应可转人工`);
      }
    }
  });
});

describe("穷举：任何 (状态 × 事件) 都不会抛异常", () => {
  test("状态机对所有组合都返回结构化结果", () => {
    for (const status of ALL_STATUSES) {
      for (const event of ALL_EVENTS) {
        const result = transition(status, event);
        assert.equal(typeof result.ok, "boolean");
        if (!result.ok) {
          assert.equal(typeof result.reason, "string");
          assert.notEqual(result.reason, "", `${status}+${event.type} 缺少拒绝理由`);
        }
      }
    }
  });
});
