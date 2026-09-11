/**
 * 订单状态机。
 *
 * 纯函数、不碰 IO —— 状态迁移是「客户的钱」和「上游的货」之间唯一的桥，
 * 必须能被穷举测试，而不是散落在各个 handler 的 if 里。
 *
 * 最重要的一条不变式：**已付款的订单永远不会流向"过期/作废"**。
 * 支付窗口关闭与链上到账是两个独立的时钟，天然会赛跑；只要有一次让
 * 「已到账」被「已超时」覆盖，那笔钱就成了客户付了、系统不认的黑账。
 */

/** 订单状态。名字直接对应客户在订单页看到的措辞，不要为了简洁改动。 */
export type OrderStatus =
  /** 刚创建，尚未分配收款地址与金额。 */
  | "draft"
  /** 已分配收款信息，等待客户付款；支付窗口计时中。 */
  | "awaiting_payment"
  /** 链上已确认到账，等待向上游进货。 */
  | "paid"
  /** 正在向上游下单。**这个状态期间绝不允许重复发起进货**。 */
  | "procuring"
  /** 已拿到卡密并交付客户。终态。 */
  | "fulfilled"
  /** 上游明确拒绝（缺货等），钱已收但货没拿到，待退款。 */
  | "procurement_failed"
  /** 已退款。终态。 */
  | "refunded"
  /**
   * 需要人工介入。进入此状态的订单**一律不自动重试、不自动退款** ——
   * 典型来源是"上游可能已扣款但卡取不回来"，自动退款会让我们既赔货又赔钱。
   */
  | "needs_review"
  /** 支付窗口内未付款，已作废。终态。 */
  | "expired";

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  "fulfilled",
  "refunded",
  "expired",
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 触发状态迁移的事件。 */
export type OrderEvent =
  /** 收款地址与唯一金额已分配。 */
  | { type: "payment_requested" }
  /** 链上确认到账。携带凭据以便落库对账。 */
  | { type: "payment_confirmed"; txHash: string; amount: string }
  /** 支付窗口到期。 */
  | { type: "payment_window_elapsed" }
  /** 开始向上游进货。 */
  | { type: "procurement_started" }
  /** 上游返回卡密。 */
  | { type: "procurement_succeeded"; supplierTradeNo: string; secret: string }
  /** 上游明确拒绝，钱一定没扣。 */
  | { type: "procurement_rejected"; reason: string }
  /** 上游没有确定答复，可能已扣款。 */
  | { type: "procurement_ambiguous"; reason: string }
  /** 人工或自动完成退款。 */
  | { type: "refund_completed" }
  /** 人工把订单挑出来处理。 */
  | { type: "flagged_for_review"; reason: string };

export interface TransitionOk {
  ok: true;
  next: OrderStatus;
}

export interface TransitionRejected {
  ok: false;
  /** 为什么这个迁移不被允许。会写进审计日志，措辞要能直接给人看。 */
  reason: string;
  /**
   * true 表示"事件与当前状态重复、可安全忽略"（比如链上确认回调重放）。
   * false 表示这是真正的异常，应当告警。
   */
  benign: boolean;
}

export type TransitionResult = TransitionOk | TransitionRejected;

const ok = (next: OrderStatus): TransitionOk => ({ ok: true, next });
const reject = (reason: string, benign = false): TransitionRejected => ({
  ok: false,
  reason,
  benign,
});

/**
 * 计算下一个状态。
 *
 * 刻意写成一个大 switch 而不是查表：每条迁移旁边都需要写清楚"为什么允许"
 * 或"为什么拒绝"，查表结构装不下这些理由，而这些理由正是这个文件的价值。
 */
export function transition(
  current: OrderStatus,
  event: OrderEvent,
): TransitionResult {
  // 终态一律不再迁移。放在最前面，避免后面每个分支都要重复判断。
  // 例外：fulfilled 收到重复的 procurement_succeeded 是回调重放，属良性。
  if (isTerminal(current)) {
    if (current === "fulfilled" && event.type === "procurement_succeeded") {
      return reject("订单已交付，忽略重复的进货成功事件", true);
    }
    if (current === "expired" && event.type === "payment_window_elapsed") {
      return reject("订单已过期，忽略重复的超时事件", true);
    }
    return reject(`订单已处于终态 ${current}，不接受 ${event.type}`);
  }

  switch (event.type) {
    case "payment_requested":
      if (current === "draft") return ok("awaiting_payment");
      if (current === "awaiting_payment") {
        // 客户刷新收款页会重复触发，不是错误。
        return reject("收款信息已分配", true);
      }
      return reject(`${current} 状态不能重新分配收款信息`);

    case "payment_confirmed":
      if (current === "awaiting_payment") return ok("paid");
      // 链上监听器天然会重复投递同一笔确认（重启、重扫、多节点），
      // 在已付款之后的任何状态收到它都属良性重复，绝不能因此回退状态。
      if (current === "paid" || current === "procuring") {
        return reject("该订单已确认收款，忽略重复的到账事件", true);
      }
      if (current === "draft") {
        // 还没给客户地址就收到款，说明金额打标撞号或有人手动转账。
        // 这是真异常，必须告警而不是静默放行。
        return reject("订单尚未分配收款信息却收到到账事件，需人工核对");
      }
      return reject(`${current} 状态收到到账事件，需人工核对`);

    case "payment_window_elapsed":
      if (current === "awaiting_payment") return ok("expired");
      // —— 核心不变式：已付款的订单不因超时作废 ——
      // 客户在窗口最后一秒付款、链上确认稍晚于定时器，是必然会发生的赛跑。
      if (current === "paid" || current === "procuring") {
        return reject("订单已付款，超时不再作废", true);
      }
      if (current === "draft") return ok("expired");
      return reject(`${current} 状态不受支付超时影响`, true);

    case "procurement_started":
      if (current === "paid") return ok("procuring");
      if (current === "procuring") {
        // 并发的履约任务抢同一张单。拒绝是对的 —— 放行会导致向上游重复下单。
        return reject("该订单正在进货中，拒绝重复发起");
      }
      return reject(`只有已付款的订单能进货，当前为 ${current}`);

    case "procurement_succeeded":
      if (current === "procuring") return ok("fulfilled");
      if (current === "needs_review") {
        // 人工捞回卡密后补录，是合法的收尾路径。
        return ok("fulfilled");
      }
      return reject(`${current} 状态不能标记为已交付`);

    case "procurement_rejected":
      // 上游明确拒绝 = 钱一定没扣，可以安全地走退款。
      if (current === "procuring") return ok("procurement_failed");
      return reject(`${current} 状态不能标记为进货失败`);

    case "procurement_ambiguous":
      // 上游无确定答复 = 可能已扣款。一律转人工，不自动退款也不自动重试。
      if (current === "procuring") return ok("needs_review");
      return reject(`${current} 状态不应产生不确定的进货结果`);

    case "refund_completed":
      if (current === "procurement_failed" || current === "needs_review") {
        return ok("refunded");
      }
      return reject(`${current} 状态不能标记为已退款`);

    case "flagged_for_review":
      if (current === "needs_review") return reject("订单已在人工队列中", true);
      // 任何非终态订单都允许人工挑出来 —— 这是最后的兜底闸门，不设限制。
      return ok("needs_review");

    default: {
      const exhaustive: never = event;
      return reject(`未知事件: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 该状态下客户能否看到卡密。 */
export function canRevealSecret(status: OrderStatus): boolean {
  return status === "fulfilled";
}

/** 该状态下我们是否欠客户一笔退款。 */
export function owesRefund(status: OrderStatus): boolean {
  return status === "procurement_failed";
}

/**
 * 该状态是否需要人看一眼。
 * needs_review 顾名思义；procurement_failed 虽可自动退款，但连续出现
 * 通常意味着上游出了问题，同样值得出现在后台的待办里。
 */
export function needsAttention(status: OrderStatus): boolean {
  return status === "needs_review" || status === "procurement_failed";
}
