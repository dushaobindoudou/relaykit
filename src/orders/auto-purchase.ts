/**
 * 自动中转采购编排。
 *
 * 客户付款确认后（paid/reserved），fulfillOrder 走到这里：
 *
 *   1. startUpstreamPurchase —— 游客身份向上游下单（凑单到通道门槛），
 *      解析 USDT 收银台，把应付金额/地址/链记到订单上；
 *   2. settleUpstreamPurchases —— 每分钟 cron：
 *      未付款的用热钱包付款（护栏拦截则转人工），
 *      已付款的轮询到账 → 查上游订单 → 取卡密 → 交付。
 *
 * 亏损路径全部映射到既有状态机：
 *   上游拒绝           → procurement_rejected（钱没出去，可安全退款）
 *   付了款上游没发货   → procurement_ambiguous（转人工对账，绝不静默重试）
 *   付款金额超护栏     → flagged_for_review（人工决定付不付）
 *   未配置热钱包私钥   → flagged_for_review（自动付款明确关闭）
 */

import { and, eq, isNotNull } from "drizzle-orm";

import type { DaichongContext } from "@/runtime/context";
import { sendUsdt, chainFromLabel } from "@/payments/disburser";
import {
  AcgFakaPurchaseClient,
  UpstreamTradeError,
  isMinimumAmountError,
} from "@/supplier/acgfaka/purchase";
import { orders, type Order } from "@/db/schema";
import type { OrderStatus } from "@/orders/state";
import { applyEvent, getOrder } from "@/orders/service";
import { findProduct } from "@/catalog/sync";
import type { SupplierConfig } from "@/config/schema";

/** 出款执行器。测试时注入假的，运行时用真热钱包。 */
export type DisbursementExecutor = typeof sendUsdt;

let executor: DisbursementExecutor = sendUsdt;

/** 测试注入。返回值是恢复函数。 */
export function setDisbursementExecutor(
  replacement: DisbursementExecutor,
): () => void {
  const previous = executor;
  executor = replacement;
  return () => {
    executor = previous;
  };
}

export function buildPurchaseClient(
  context: DaichongContext,
  supplier: SupplierConfig,
): AcgFakaPurchaseClient {
  return new AcgFakaPurchaseClient({
    domain: supplier.domain ?? "",
    timeoutMs: supplier.timeoutMs,
    ...(supplier.relayUrl ? { relayUrl: supplier.relayUrl } : {}),
    ...(context.secrets.relaySecret ? { relaySecret: context.secrets.relaySecret } : {}),
  });
}

/** 订单所属供应商的自动采购配置；未启用返回 null（走适配器/人工路径）。 */
export function getAutoPurchase(
  context: DaichongContext,
  supplierId: string,
): SupplierConfig["autoPurchase"] | null {
  const supplier = context.config.suppliers.find((item) => item.id === supplierId);
  if (!supplier) return null;
  if (supplier.driver !== "acgfaka-public") return null;
  if (!supplier.autoPurchase?.enabled) return null;
  return supplier.autoPurchase;
}

/**
 * 凑单数量：上游 USDT 通道有最低金额门槛，订单量不足时多买 ——
 * 多出的余量留在上游发货结果里，叠加进本地库存口径（成本也真实）。
 * 用我们同步到的成本价估算件数，与上游实付只差批发折扣，方向偏保守。
 */
export function batchSize(quantity: number, unitCostCny: number, minBatchCny: string): number {
  if (unitCostCny <= 0) return quantity;
  const needed = Math.ceil(Number(minBatchCny) / unitCostCny);
  return Math.max(quantity, needed);
}

/**
 * 阶段一：向上游下单。状态机已处于 procuring（fulfillOrder 开过
 * procurement_started），这里只做上游侧的事并把凭据记到订单上。
 */
export async function startUpstreamPurchase(
  context: DaichongContext,
  order: Order,
  autoPurchase: NonNullable<SupplierConfig["autoPurchase"]>,
): Promise<{ ok: boolean; status: OrderStatus; message: string }> {
  const supplier = context.config.suppliers.find((item) => item.id === order.supplierId);
  if (!supplier?.domain) {
    await applyEvent(context, order, {
      type: "flagged_for_review",
      reason: "自动采购配置缺少上游 domain",
    }, { reviewReason: "自动采购配置缺少上游 domain" });
    return { ok: false, status: "needs_review", message: "配置不完整，已转人工" };
  }

  // 调用方（fulfillOrder）手里的对象带着 procurement_started 之前的旧状态，
  // 状态机的迁移判断以传入对象的 status 为准 —— 必须重读，否则后续
  // procurement_rejected 等事件会因「状态不匹配」被拒。
  const fresh = await getOrder(context, order.id);
  if (fresh) order = fresh;

  const client = buildPurchaseClient(context, supplier);

  try {
    const html = await client.fetchItemHtml(order.productCode);
    const confirm = client.extractConfirm(html);

    // 凑单：用同步到的成本价估算。
    const product = await findProduct(context, order.supplierId, order.productCode, order.race);
    const unitCost = product ? Number(product.cost) : 0;
    const num = batchSize(order.quantity, unitCost, autoPurchase.minBatchCny);

    const trade = await client.createTrade({
      itemId: order.productCode,
      race: order.race,
      num,
      contact: autoPurchase.contact,
      payChannelId: autoPurchase.payChannelId,
      confirm,
    });
    const payment = await client.parseUsdtCashier(trade.payPath);

    await context.db
      .update(orders)
      .set({
        upstreamTradeNo: trade.tradeNo,
        upstreamPayAmount: payment.amountUsdt,
        upstreamPayAddress: payment.address,
        upstreamPayChain: payment.chainLabel,
        upstreamContact: autoPurchase.contact,
        upstreamAttempt: order.upstreamAttempt + 1,
      })
      .where(eq(orders.id, order.id));

    return {
      ok: true,
      status: "procuring",
      message: `已向上游下单 ${trade.tradeNo}（${payment.amountUsdt} USDT），等待自动付款`,
    };
  } catch (error) {
    // 上游明确拒绝（含缺货）：钱没出去，安全地走待退款。
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof UpstreamTradeError && error.kind === "sold_out") {
      await applyEvent(context, order, { type: "procurement_rejected", reason }, { reviewReason: reason });
      return { ok: false, status: "procurement_failed", message: reason };
    }
    // 其余（网络/改版/解析失败）：保持 procuring，等下一轮 cron 重试，
    // 重试上限内不轻易转人工 —— 上游抖动是常态。
    console.error(`[auto-purchase] 订单 ${order.id} 下单失败: ${reason}`);
    return { ok: true, status: "procuring", message: `上游下单暂未成功，将自动重试：${reason}` };
  }
}

interface SettleResult {
  handled: number;
  delivered: number;
  flagged: number;
}

/**
 * 阶段二：每分钟 cron 的结算与轮询循环。
 * executor 参数仅供测试注入，运行时永远走真热钱包。
 */
export async function settleUpstreamPurchases(
  context: DaichongContext,
  options: { executor?: DisbursementExecutor; limit?: number } = {},
): Promise<SettleResult> {
  const doPay = options.executor ?? executor;
  const rows = await context.db
    .select()
    .from(orders)
    .where(and(eq(orders.status, "procuring"), isNotNull(orders.upstreamTradeNo)))
    .limit(options.limit ?? 10);

  const result: SettleResult = { handled: 0, delivered: 0, flagged: 0 };

  for (const order of rows) {
    result.handled += 1;
    const outcome = await settleOne(context, order, doPay);
    if (outcome === "delivered") result.delivered += 1;
    if (outcome === "flagged") result.flagged += 1;
  }
  return result;
}

type SettleOutcome = "delivered" | "flagged" | "waiting" | "failed";

async function settleOne(
  context: DaichongContext,
  order: Order,
  doPay: DisbursementExecutor,
): Promise<SettleOutcome> {
  const supplier = context.config.suppliers.find((item) => item.id === order.supplierId);
  const autoPurchase = getAutoPurchase(context, order.supplierId);
  if (!supplier?.domain || !autoPurchase || !order.upstreamTradeNo) {
    return "waiting";
  }
  const client = buildPurchaseClient(context, supplier);

  // —— 第一步：没付就付（护栏在先）——
  if (!order.upstreamPaidTxHash) {
    const amount = Number(order.upstreamPayAmount ?? "0");
    if (!(amount > 0)) {
      return "waiting"; // 没解析到金额，等下一轮（可能在重试下单）
    }
    if (amount > Number(autoPurchase.maxPayUsdt)) {
      await applyEvent(
        context,
        order,
        {
          type: "flagged_for_review",
          reason: `上游应付 ${order.upstreamPayAmount} USDT 超出单笔护栏 ${autoPurchase.maxPayUsdt}`,
        },
        { reviewReason: "自动付款超护栏，请人工在上游付款或退款" },
      );
      return "flagged";
    }

    const chain = chainFromLabel(order.upstreamPayChain ?? "");
    if (!chain) {
      await applyEvent(
        context,
        order,
        {
          type: "flagged_for_review",
          reason: `收款链 "${order.upstreamPayChain ?? "未知"}" 不支持自动出款`,
        },
        { reviewReason: "请人工在上游付款（TRC20/未知链），或退款" },
      );
      return "flagged";
    }
    if (!context.secrets.payoutWalletKey) {
      await applyEvent(
        context,
        order,
        { type: "flagged_for_review", reason: "未配置 PAYOUT_WALLET_KEY，自动付款不可用" },
        { reviewReason: "配置热钱包私钥后此单将自动继续；或人工在上游付款/退款" },
      );
      return "flagged";
    }

    const spec = chain === "polygon" ? "polygon" : "bsc";
    try {
      const sent = await doPay({
        chainId: spec,
        to: order.upstreamPayAddress ?? "",
        amountUsdt: order.upstreamPayAmount ?? "0",
        privateKey: context.secrets.payoutWalletKey,
        rpcUrls: [],
      });
      await context.db
        .update(orders)
        .set({ upstreamPaidTxHash: sent.txHash })
        .where(eq(orders.id, order.id));
      console.log(
        `[auto-purchase] 订单 ${order.id} 已出款 ${order.upstreamPayAmount} USDT → ${order.upstreamPayAddress} (tx ${sent.txHash})`,
      );
      return "waiting"; // 付款后等上游确认，下一轮再来收货
    } catch (error) {
      // 出款失败：不上报状态机（钱还在我们钱包里），落到下面的轮询段
      // 顺带检查上游订单是否已过期 —— 没付出去的单过期了要重下。
      console.error(`[auto-purchase] 订单 ${order.id} 出款失败:`, error instanceof Error ? error.message : error);
    }
  }

  // —— 第二步：轮询上游到账与发货（已付款或付款失败后顺带检查）——
  try {
    const payment = await client.queryPayment(order.upstreamTradeNo!);
    if (payment.status !== 1) {
      // 20 分钟收银台窗口。还没到账：如果是我们没付出去，重新下单；
      // 如果我们已经付了但上游订单过期，资金去向不明 → 人工对账。
      const row = await client.queryOrder(order.upstreamTradeNo!);
      if (row === null) {
        await handleExpired(context, order);
        return "failed";
      }
      return "waiting";
    }

    const row = await client.queryOrder(order.upstreamTradeNo!);
    if (!row) {
      // 已到账但查不到订单 —— 罕见且危险，交人工。
      await markAmbiguous(context, order, "链上已到账但上游订单查询不到");
      return "flagged";
    }
    if (row.deliveryStatus !== 1) {
      // 到账了上游还没发货（人工发货型商品或延迟）——继续等。
      return "waiting";
    }

    const secret = await client.fetchSecret(order.upstreamTradeNo!);
    await applyEvent(
      context,
      order,
      {
        type: "procurement_succeeded",
        supplierTradeNo: order.upstreamTradeNo,
        secret: secret.secret,
      },
      {
        supplierTradeNo: order.upstreamTradeNo,
        secret: secret.secret,
        leaveMessage: secret.leaveMessage || null,
      },
    );
    console.log(`[auto-purchase] 订单 ${order.id} 已从上游收货并交付`);
    return "delivered";
  } catch (error) {
    // 到账轮询接口对过期单直接返回非 200。此时无法区分「没付出去的单过期」
    // 与「付了款的单过期」—— handleExpired 按是否已有出款哈希分流：
    // 未付 → 重下；已付 → 资金去向不明，人工对账。
    await handleExpired(context, order);
    return "failed";
  }
}

/** 上游订单消失（过期清理）。未付款 → 重新下单；已付款 → 人工对账。 */
async function handleExpired(context: DaichongContext, order: Order): Promise<void> {
  if (!order.upstreamPaidTxHash && order.upstreamAttempt < 3) {
    const autoPurchase = getAutoPurchase(context, order.supplierId);
    if (autoPurchase) {
      await context.db
        .update(orders)
        .set({ upstreamTradeNo: null, upstreamPayAmount: null, upstreamPayAddress: null, upstreamPayChain: null })
        .where(eq(orders.id, order.id));
      await startUpstreamPurchase(context, order, autoPurchase);
      return;
    }
  }
  if (order.upstreamPaidTxHash) {
    await markAmbiguous(context, order, "我们已付款但上游订单已过期，资金去向需人工对账");
  } else {
    const reason = "上游下单重试超限";
    await applyEvent(context, order, { type: "procurement_rejected", reason }, { reviewReason: reason });
  }
}

async function markAmbiguous(context: DaichongContext, order: Order, reason: string): Promise<void> {
  await applyEvent(context, order, { type: "procurement_ambiguous", reason }, { reviewReason: reason });
}

export { isMinimumAmountError };
