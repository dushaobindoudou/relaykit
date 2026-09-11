/**
 * 订单服务：把状态机、数据库、上游适配器接到一起。
 *
 * 状态机（state.ts）决定「能不能迁移」，这里决定「迁移时还要做什么」，
 * 并且**每一次迁移都落审计日志**，包括被拒绝的。出问题时「这笔钱经历了什么」
 * 必须能从库里读出来，而不是靠翻已经滚掉的日志。
 */

import { and, eq, sql } from "drizzle-orm";

import { findProduct } from "@/catalog/sync";
import { isPlaceholderAddress } from "@/config/schema";
import { orderEvents, orders, type Order } from "@/db/schema";
import type { RelayKitContext } from "@/runtime/context";
import { transition, type OrderEvent, type OrderStatus } from "@/orders/state";
import type { PurchaseRequest } from "@/supplier/types";

/** 订单号：可读、可口述、不暴露总单量。 */
function newOrderId(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉 I/L/O/0/1，避免抄错
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** 幂等键与订单号分开：订单号会出现在客户面前，幂等键不该被猜到。 */
function newRequestNo(): string {
  return crypto.randomUUID();
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(`relaykit:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 记录一次状态迁移。
 *
 * 写事件与改状态必须一起成败，否则会出现「状态变了但没有记录」或反过来。
 * D1 没有交互式事务，用 batch 保证原子性。
 */
async function applyEvent(
  context: RelayKitContext,
  order: Pick<Order, "id" | "status">,
  event: OrderEvent,
  patch: Partial<Order> = {},
): Promise<{ ok: boolean; status: OrderStatus; reason?: string }> {
  const current = order.status as OrderStatus;
  const result = transition(current, event);
  const now = new Date().toISOString();

  const logRow = {
    orderId: order.id,
    eventType: event.type,
    fromStatus: current,
    toStatus: result.ok ? result.next : null,
    accepted: result.ok,
    detail: result.ok ? JSON.stringify(event) : result.reason,
    createdAt: now,
  };

  if (!result.ok) {
    await context.db.insert(orderEvents).values(logRow);
    return { ok: false, status: current, reason: result.reason };
  }

  await context.db.batch([
    context.db
      .update(orders)
      .set({ ...patch, status: result.next, updatedAt: now })
      // 带上原状态做条件更新：两个并发实例同时推进同一张单时，
      // 只有一个能匹配到行，另一个更新 0 行 —— 这是应用层拿不到的防线。
      .where(and(eq(orders.id, order.id), eq(orders.status, current))),
    context.db.insert(orderEvents).values(logRow),
  ]);

  return { ok: true, status: result.next };
}

// ———————————————————————————— 创建订单 ————————————————————————————

export interface CreateOrderInput {
  supplierId: string;
  code: string;
  race: string;
  quantity: number;
  contactEmail: string;
  /** 客户自设的订单查询口令。 */
  queryPassword: string;
  chainId: string;
}

export type CreateOrderResult =
  | { ok: true; order: Order }
  | { ok: false; error: string };

/**
 * 为订单分配一个在该链上唯一的收款金额。
 *
 * 同一个地址靠小数尾数区分订单，省掉为每单派生地址的密钥管理。
 * 唯一性由数据库的部分唯一索引兜底（只约束 awaiting_payment 的订单），
 * 这里只负责生成候选值并在冲突时换一个。
 */
function taggedAmount(price: string, decimals: number, attempt: number): string {
  const base = Number(price);
  // 尾数空间 = 10^decimals。attempt 递增时换一个随机尾数而不是 +1，
  // 避免高并发下大家挤在相邻值上反复冲突。
  const tag = crypto.getRandomValues(new Uint32Array(1))[0]! % 10 ** decimals;
  const step = 10 ** -decimals;
  // 往上加而不是往下减：少收钱比多收钱难处理。
  return (base + tag * step + attempt * step * 10 ** decimals).toFixed(decimals);
}

export async function createOrder(
  context: RelayKitContext,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const { config } = context;

  const chain = config.payments.chains.find(
    (item) => item.id === input.chainId && item.enabled,
  );
  if (!chain) return { ok: false, error: "该收款方式不可用" };

  // 占位地址绝不能进入真实订单 —— 客户会把钱打到一个我们控制不了的地方。
  if (isPlaceholderAddress(chain.address)) {
    return {
      ok: false,
      error: "该收款方式尚未配置完成，暂时无法下单",
    };
  }

  const product = await findProduct(context, input.supplierId, input.code, input.race);
  if (!product || !product.sellable || product.price === null) {
    return { ok: false, error: "该商品当前不可售" };
  }
  if (input.quantity < 1 || input.quantity > 99) {
    return { ok: false, error: "购买数量不合法" };
  }
  if (product.stock < input.quantity) {
    return { ok: false, error: `库存不足，当前仅剩 ${product.stock}` };
  }

  // 下单前现拉一次库存：快照表是定时同步的，可能已经过期。
  const adapter = context.suppliers.get(input.supplierId);
  if (adapter) {
    try {
      const live = await adapter.getStock(input.code, input.race || undefined);
      if (live < input.quantity) {
        return { ok: false, error: `库存不足，当前仅剩 ${live}` };
      }
    } catch {
      // 上游查库存失败不阻断下单 —— 真正的库存判定在进货那一步还会做一次，
      // 而那一步失败是可以安全退款的（上游明确拒绝 = 钱没扣）。
    }
  }

  const total = (Number(product.price) * input.quantity).toFixed(2);
  const now = new Date();
  const windowEnd = new Date(
    now.getTime() + config.payments.windowMinutes * 60_000,
  );
  const decimals = config.payments.amountTagging.enabled
    ? config.payments.amountTagging.decimals
    : 2;

  // 唯一金额可能撞号，重试几次。撞满说明尾数空间不够，应当调大 decimals。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = {
      id: newOrderId(),
      status: "awaiting_payment" as const,
      supplierId: input.supplierId,
      productCode: input.code,
      race: input.race,
      productName: product.name,
      quantity: input.quantity,
      priceTotal: total,
      costSnapshot: product.cost,
      fxRate: "1",
      currency: config.store.currency,
      requestNo: newRequestNo(),
      chainId: chain.id,
      payAddress: chain.address,
      payAmount: taggedAmount(total, decimals, attempt),
      payWindowEndsAt: windowEnd.toISOString(),
      contactEmail: input.contactEmail,
      queryPasswordHash: await hashPassword(input.queryPassword),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await context.db.insert(orders).values(row);
      await context.db.insert(orderEvents).values({
        orderId: row.id,
        eventType: "payment_requested",
        fromStatus: "draft",
        toStatus: "awaiting_payment",
        accepted: true,
        detail: JSON.stringify({ chain: chain.id, amount: row.payAmount }),
        createdAt: now.toISOString(),
      });
      return { ok: true, order: row as Order };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有唯一约束冲突才重试；其它错误直接上报，不要吞掉。
      if (!/UNIQUE|constraint/i.test(message)) {
        return { ok: false, error: `下单失败：${message}` };
      }
    }
  }

  return {
    ok: false,
    error:
      "当前下单量较大，暂时分配不出唯一收款金额，请稍后重试。" +
      "（管理员：调大 payments.amountTagging.decimals）",
  };
}

// ———————————————————————————— 查询 ————————————————————————————

export async function getOrder(
  context: RelayKitContext,
  id: string,
): Promise<Order | null> {
  const rows = await context.db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function verifyOrderPassword(
  order: Order,
  password: string,
): Promise<boolean> {
  if (!order.queryPasswordHash) return false;
  return (await hashPassword(password)) === order.queryPasswordHash;
}

// ———————————————————————————— 履约 ————————————————————————————

/**
 * 对一张已付款的订单执行进货。
 *
 * 这是整个系统里唯一会花钱的函数，几条纪律：
 *   - 先把状态推进到 procuring 再发请求。推进失败（并发抢单）就直接返回，
 *     绝不带着「可能有人也在进货」的疑虑继续。
 *   - requestNo 在建单时就落库了，这里只读不改 —— 重试必须复用同一个。
 *   - 结果不确定时转人工，不重试、不退款。
 */
export async function fulfillOrder(
  context: RelayKitContext,
  order: Order,
): Promise<{ ok: boolean; status: OrderStatus; message: string }> {
  const adapter = context.suppliers.get(order.supplierId);
  if (!adapter) {
    const flagged = await applyEvent(
      context,
      order,
      { type: "flagged_for_review", reason: "找不到上游适配器" },
      { reviewReason: `配置里没有上游 "${order.supplierId}"` },
    );
    return { ok: false, status: flagged.status, message: "上游配置缺失，已转人工" };
  }

  const started = await applyEvent(context, order, { type: "procurement_started" });
  if (!started.ok) {
    return { ok: false, status: started.status, message: started.reason ?? "" };
  }

  // exactOptionalPropertyTypes 下，可选属性要么不出现、要么是确定的值，
  // 不能显式赋 undefined。空规格与空联系方式直接不带这个字段。
  const request: PurchaseRequest = {
    code: order.productCode,
    quantity: order.quantity,
    requestNo: order.requestNo,
    ...(order.race ? { race: order.race } : {}),
    ...(order.contactEmail ? { contact: order.contactEmail } : {}),
  };

  const outcome = await adapter.purchase(request);
  const inProgress = { id: order.id, status: "procuring" as OrderStatus };

  if (outcome.kind === "success") {
    await applyEvent(
      context,
      inProgress,
      {
        type: "procurement_succeeded",
        supplierTradeNo: outcome.supplierTradeNo,
        secret: outcome.secret,
      },
      {
        supplierTradeNo: outcome.supplierTradeNo,
        secret: outcome.secret,
        leaveMessage: outcome.leaveMessage ?? null,
      },
    );
    return { ok: true, status: "fulfilled", message: "已发货" };
  }

  if (outcome.kind === "rejected") {
    // 上游明确拒绝 = 钱一定没扣，可以安全地进入待退款。
    await applyEvent(
      context,
      inProgress,
      { type: "procurement_rejected", reason: outcome.reason },
      { reviewReason: outcome.reason },
    );
    return {
      ok: false,
      status: "procurement_failed",
      message: `上游拒绝：${outcome.reason}`,
    };
  }

  // —— 结果不确定：可能已扣款 ——
  // 用同一个 requestNo 补打一次，靠上游的去重行为反推第一次的结局。
  const resolution = await adapter.resolveAmbiguous(request);

  if (resolution.kind === "recovered") {
    await applyEvent(
      context,
      inProgress,
      {
        type: "procurement_succeeded",
        supplierTradeNo: resolution.purchase.supplierTradeNo,
        secret: resolution.purchase.secret,
      },
      {
        supplierTradeNo: resolution.purchase.supplierTradeNo,
        secret: resolution.purchase.secret,
        leaveMessage: resolution.purchase.leaveMessage ?? null,
      },
    );
    return { ok: true, status: "fulfilled", message: "补发成功" };
  }

  if (resolution.kind === "not_charged") {
    await applyEvent(
      context,
      inProgress,
      { type: "procurement_rejected", reason: resolution.reason },
      { reviewReason: resolution.reason },
    );
    return {
      ok: false,
      status: "procurement_failed",
      message: `上游拒绝：${resolution.reason}`,
    };
  }

  // charged_unrecoverable / still_ambiguous：一律人工，绝不自动退款。
  await applyEvent(
    context,
    inProgress,
    { type: "procurement_ambiguous", reason: resolution.reason },
    { reviewReason: resolution.reason },
  );
  return {
    ok: false,
    status: "needs_review",
    message: "进货结果不确定，已转人工处理",
  };
}

/** 关闭超时未付款的订单，释放它占用的唯一金额。 */
export async function expireStaleOrders(
  context: RelayKitContext,
  now = new Date(),
): Promise<number> {
  const stale = await context.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, "awaiting_payment"),
        sql`${orders.payWindowEndsAt} < ${now.toISOString()}`,
      ),
    );

  let closed = 0;
  for (const order of stale) {
    const result = await applyEvent(context, order, {
      type: "payment_window_elapsed",
    });
    if (result.ok) closed += 1;
  }
  return closed;
}

/** 链上确认到账。由收款监听调用。 */
export async function markPaid(
  context: RelayKitContext,
  order: Order,
  txHash: string,
  amount: string,
): Promise<{ ok: boolean; status: OrderStatus }> {
  const result = await applyEvent(
    context,
    order,
    { type: "payment_confirmed", txHash, amount },
    { paidTxHash: txHash, paidAmount: amount, paidAt: new Date().toISOString() },
  );
  return { ok: result.ok, status: result.status };
}
