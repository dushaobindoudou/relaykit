/**
 * 订单服务：把状态机、数据库、上游适配器接到一起。
 *
 * 状态机（state.ts）决定「能不能迁移」，这里决定「迁移时还要做什么」，
 * 并且**每一次迁移都落审计日志**，包括被拒绝的。出问题时「这笔钱经历了什么」
 * 必须能从库里读出来，而不是靠翻已经滚掉的日志。
 */

import { and, eq, sql } from "drizzle-orm";

import { findProduct, fxFromConfig } from "@/catalog/sync";
import { loadManualOverrides, resolveManualConfig } from "@/payments/manual-channels";
import { manualUnitPrice } from "@/pricing/engine";
import { isPlaceholderAddress } from "@/config/schema";
import { orderEvents, orders, type Order } from "@/db/schema";
import type { DaichongContext } from "@/runtime/context";
import { transition, type OrderEvent, type OrderStatus } from "@/orders/state";
import type { PurchaseRequest } from "@/supplier/types";
import * as ledger from "@/accounts/balance";
import { getAutoPurchase, startUpstreamPurchase } from "@/orders/auto-purchase";
import * as couponService from "@/pricing/coupon";
import { tagAmount } from "@/payments/tagging";
import type { User } from "@/db/schema";

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
export async function applyEvent(
  context: DaichongContext,
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

  // 带原状态做条件更新：两个并发实例同时推进同一张单时，只有一个能
  // 匹配到行。用 returning 的行数判断是否真的抢到 —— D1 的 update
  // 匹配 0 行不报错，不检查就会让「输掉竞态的一方」也以为迁移成功了
  // （退款入账两次的根源就在这里）。
  const [updatedRows] = await context.db.batch([
    context.db
      .update(orders)
      .set({ ...patch, status: result.next, updatedAt: now })
      .where(and(eq(orders.id, order.id), eq(orders.status, current)))
      .returning({ id: orders.id }),
    context.db.insert(orderEvents).values(logRow),
  ]);

  if (updatedRows.length === 0) {
    return {
      ok: false,
      status: current,
      reason: "并发更新：该订单已被其他操作推进，本次迁移未生效",
    };
  }

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
  /** 链上支付时必填；余额支付时忽略。 */
  chainId?: string;
  /** "balance" 走余额扣款；"chain" 走链上收款；其余视为手动收款渠道 id（如 alipay/wechat）。 */
  payMethod?: string;
  /** 登录用户。余额支付必须有。 */
  user?: User | null;
  couponCode?: string;
}

export type CreateOrderResult =
  | { ok: true; order: Order }
  | { ok: false; error: string };

export async function createOrder(
  context: DaichongContext,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const { config } = context;
  const payMethod = input.payMethod ?? "chain";

  if (payMethod === "balance" && !input.user) {
    return { ok: false, error: "余额支付需要先登录" };
  }

  // —— 手动收款渠道（支付宝/微信转账）：管理员确认到账后照走自动采购 ——
  // 渠道清单优先取后台运营态（收款码/账号可改），配置文件只是初始值。
  const manualConfig = resolveManualConfig(config, await loadManualOverrides(context.db)) ?? undefined;
  const manualChannel =
    payMethod !== "chain" && payMethod !== "balance"
      ? manualConfig?.channels.find((item) => item.id === payMethod) ?? null
      : null;
  if (payMethod !== "chain" && payMethod !== "balance" && !manualChannel) {
    return { ok: false, error: "该收款方式不可用" };
  }

  // —— 链上支付：先确认这条链真的能收钱 ——
  let chain = null as (typeof config.payments.chains)[number] | null;
  if (payMethod === "chain") {
    chain =
      config.payments.chains.find(
        (item) => item.id === input.chainId && item.enabled,
      ) ?? null;
    if (!chain) return { ok: false, error: "该收款方式不可用" };

    // 占位地址绝不能进入真实订单 —— 客户会把钱打到一个我们控制不了的地方。
    if (isPlaceholderAddress(chain.address)) {
      return { ok: false, error: "该收款方式尚未配置完成，暂时无法下单" };
    }
  }

  const product = await findProduct(context, input.supplierId, input.code, input.race);
  if (!product || !product.sellable || product.price === null) {
    return { ok: false, error: "该商品当前不可售" };
  }
  if (input.quantity < 1 || input.quantity > 99) {
    return { ok: false, error: "购买数量不合法" };
  }

  // —— 预订判定 ——
  // 库存不足时：可预订的商品允许下单（付款占位、补货发货、可退余额），
  // 不可预订的明确拒绝。绝不能静默放行缺货单 —— 那会变成一笔必退款的订单。
  const shortStock = product.stock < input.quantity;
  if (shortStock && !product.reservable) {
    return { ok: false, error: `库存不足，当前仅剩 ${product.stock}` };
  }
  const reservation = shortStock;

  // 下单前现拉一次库存：快照表是定时同步的，可能已经过期。
  // 预订单不拦 —— 等的就是补货。
  const adapter = context.suppliers.get(input.supplierId);
  if (adapter && !reservation) {
    try {
      const live = await adapter.getStock(input.code, input.race || undefined);
      if (live < input.quantity) {
        if (!product.reservable) {
          return { ok: false, error: `库存不足，当前仅剩 ${live}` };
        }
      }
    } catch {
      // 上游查库存失败不阻断下单 —— 真正的库存判定在进货那一步还会做一次，
      // 而那一步失败是可以安全退款的（上游明确拒绝 = 钱没扣）。
    }
  }

  // —— 定价：阶梯价 → 小计 → 优惠券 ——
  // 手动收款渠道按成本口径重算（30% 加价），其余用同步好的链上售价。
  const tierUnitPrice = resolveUnitPrice(product, input.quantity);
  const unitPrice = manualChannel
    ? manualUnitPrice({
        cost: product.cost,
        baseRetailPrice: product.price,
        tierUnitPrice,
        rates: fxFromConfig(context).rates,
        fromCurrency:
          context.config.suppliers.find((item) => item.id === input.supplierId)?.currency ?? "CNY",
        toCurrency: config.store.currency,
        markupPercent: manualConfig!.markupPercent,
        rounding: config.pricing.rounding,
      })
    : tierUnitPrice;
  const subtotal = (Number(unitPrice) * input.quantity).toFixed(2);
  const costTotal = (Number(product.cost) * input.quantity).toFixed(2);

  let discount = "0";
  let total = subtotal;
  const identity = input.user?.id ?? input.contactEmail.toLowerCase();

  if (input.couponCode) {
    const check = await couponService.validate(context, {
      code: input.couponCode,
      subtotal,
      cost: costTotal,
      productCode: input.code,
      identity,
      minMarginPercent: config.pricing.minMarginPercent,
    });

    if (!check.ok) {
      return { ok: false, error: couponError(check.reason, check.detail) };
    }
    discount = check.discount;
    total = check.payable;
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + config.payments.windowMinutes * 60_000);
  const decimals = config.payments.amountTagging.enabled
    ? config.payments.amountTagging.decimals
    : 2;

  const base = {
    supplierId: input.supplierId,
    productCode: input.code,
    race: input.race,
    productName: product.name,
    quantity: input.quantity,
    priceTotal: total,
    costSnapshot: costTotal,
    fxRate: "1",
    currency: config.store.currency,
    couponCode: input.couponCode ? input.couponCode.trim().toUpperCase() : null,
    discount,
    userId: input.user?.id ?? null,
    payMethod,
    contactEmail: input.contactEmail,
    queryPasswordHash: await hashPassword(input.queryPassword),
    reservation,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  // —— 余额支付：扣款成功即视为已付款，无需链上等待 ——
  if (payMethod === "balance") {
    const orderId = newOrderId();

    // 先扣款再建单。反过来的话，扣款失败会留下一张永远付不了的订单；
    // 而这个顺序下最坏情况是扣了款没建单，那是有流水可查、可人工补的。
    const charged = await ledger.postWithRetry(context, {
      userId: input.user!.id,
      kind: "spend",
      amount: `-${total}`,
      orderId,
      note: product.name,
    });

    if (!charged.ok) {
      return {
        ok: false,
        error:
          charged.error === "insufficient_funds"
            ? "余额不足，请先充值"
            : "扣款失败，请重试",
      };
    }

    const row = {
      ...base,
      id: orderId,
      // 预订单从这一刻起就在预订队列里，等补货；普通单直接进入待进货。
      status: (reservation ? "reserved" : "paid") as "reserved" | "paid",
      requestNo: newRequestNo(),
      paidAt: now.toISOString(),
      payAmount: total,
    };

    await context.db.insert(orders).values(row);
    await context.db.insert(orderEvents).values({
      orderId,
      eventType: reservation ? "reservation_opened" : "payment_confirmed",
      fromStatus: "draft",
      toStatus: row.status,
      accepted: true,
      detail: JSON.stringify({ payMethod: "balance", amount: total, reservation }),
      createdAt: now.toISOString(),
    });

    if (input.couponCode) {
      await couponService.redeem(context, input.couponCode, orderId, identity, discount);
    }

    return { ok: true, order: row as unknown as Order };
  }

  // —— 手动收款（支付宝/微信转账）：不分配链上地址，管理员确认到账后
  // markPaid 进入与链上单完全相同的自动采购管线。 ——
  if (manualChannel) {
    const orderId = newOrderId();
    const manualWindowEnd = new Date(now.getTime() + manualConfig!.windowHours * 3_600_000);
    const row = {
      ...base,
      id: orderId,
      status: "awaiting_payment" as const,
      requestNo: newRequestNo(),
      // 人工对账按订单号核对转账，不靠金额打标 —— 不占用链上金额槽位，
      // 也绝不能带地址：watcher 按 (地址, 金额) 匹配，空字段天然不匹配。
      payAmount: null,
      chainId: null,
      payAddress: null,
      payWindowEndsAt: manualWindowEnd.toISOString(),
    };

    await context.db.insert(orders).values(row);
    await context.db.insert(orderEvents).values({
      orderId,
      eventType: "payment_requested",
      fromStatus: "draft",
      toStatus: "awaiting_payment",
      accepted: true,
      detail: JSON.stringify({ manual: manualChannel.id, amount: total }),
      createdAt: now.toISOString(),
    });

    if (input.couponCode) {
      await couponService.redeem(context, input.couponCode, orderId, identity, discount);
    }

    return { ok: true, order: row as unknown as Order };
  }

  // —— 链上支付：分配唯一收款金额 ——
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const orderId = newOrderId();
    const row = {
      ...base,
      id: orderId,
      status: "awaiting_payment" as const,
      requestNo: newRequestNo(),
      chainId: chain!.id,
      payAddress: chain!.address,
      // 每次循环重新取随机尾数；撞号只需再试一次，绝不在上次基础上递增。
      payAmount: tagAmount(total, decimals),
      payWindowEndsAt: windowEnd.toISOString(),
    };

    try {
      await context.db.insert(orders).values(row);
      await context.db.insert(orderEvents).values({
        orderId,
        eventType: "payment_requested",
        fromStatus: "draft",
        toStatus: "awaiting_payment",
        accepted: true,
        detail: JSON.stringify({ chain: chain!.id, amount: row.payAmount }),
        createdAt: now.toISOString(),
      });

      if (input.couponCode) {
        await couponService.redeem(context, input.couponCode, orderId, identity, discount);
      }

      return { ok: true, order: row as unknown as Order };
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

/**
 * 批发阶梯价：买得多单价更低。
 *
 * 阶梯存的是**我们对客**的价格，不是上游给我们的进货阶梯 —— 混淆会导致
 * 按进货价卖给客户。取满足 minQty 的最后一档（阶梯按 minQty 升序存）。
 */
export function resolveUnitPrice(
  product: { price: string | null; wholesaleTiers: string | null },
  quantity: number,
): string {
  const base = product.price ?? "0";
  if (!product.wholesaleTiers) return base;

  try {
    const tiers = JSON.parse(product.wholesaleTiers) as {
      minQty: number;
      price: string;
    }[];
    let chosen = base;
    for (const tier of tiers) {
      if (quantity >= tier.minQty) chosen = tier.price;
    }
    // 阶梯价高于原价说明配置有误，此时按原价走 —— 绝不因为配置错误多收客户钱。
    return Number(chosen) < Number(base) ? chosen : base;
  } catch {
    return base;
  }
}

function couponError(reason: couponService.CouponRejection, detail?: string): string {
  switch (reason) {
    case "not_found":
      return "优惠码不存在";
    case "inactive":
      return "该优惠码已停用";
    case "expired":
      return "该优惠码已过期";
    case "usage_limit":
      return "该优惠码已被领完";
    case "per_user_limit":
      return "你已使用过该优惠码";
    case "min_amount":
      return `订单金额需满 ${detail} 才能使用该优惠码`;
    case "wrong_product":
      return "该优惠码不适用于此商品";
    case "below_cost":
      // 不告诉客户「毛利不足」—— 那是我们的成本信息。
      return "该优惠码不适用于此商品";
    default:
      return "优惠码不可用";
  }
}

// ———————————————————————————— 查询 ————————————————————————————

export async function getOrder(
  context: DaichongContext,
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
  context: DaichongContext,
  order: Order,
): Promise<{ ok: boolean; status: OrderStatus; message: string }> {
  // 自动中转采购：以上游普通客户的身份游客下单 + 热钱包自动付款，
  // 走完「付款→到账→收卡」后再交付。不依赖适配器，与适配器路径互斥。
  const autoPurchase = getAutoPurchase(context, order.supplierId);
  if (autoPurchase) {
    const started = await applyEvent(context, order, { type: "procurement_started" });
    if (!started.ok) {
      return { ok: false, status: started.status, message: started.reason ?? "" };
    }
    return startUpstreamPurchase(context, order, autoPurchase);
  }

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
  context: DaichongContext,
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
  context: DaichongContext,
  order: Order,
  txHash: string,
  amount: string,
): Promise<{ ok: boolean; status: OrderStatus }> {
  // 预订单到账进入预订队列而非立即进货 —— 客户在订单页看到的是「预订中」。
  // 事件分开，审计日志才能区分「马上进货」与「排队等货」这两种钱一样、
  // 货完全不同的去向。
  const result = await applyEvent(
    context,
    order,
    order.reservation
      ? { type: "reservation_opened" }
      : { type: "payment_confirmed", txHash, amount },
    { paidTxHash: txHash, paidAmount: amount, paidAt: new Date().toISOString() },
  );
  return { ok: result.ok, status: result.status };
}

/**
 * 预订单退到余额。客户自助操作，条件从严：
 * 只有 reserved 状态、登录、且是本人订单才允许 —— 余额是「记在账上」的钱，
 * 退给谁必须唯一确定，匿名链上付款的退款走人工。
 */
export async function refundReservationToBalance(
  context: DaichongContext,
  orderId: string,
  user: User,
): Promise<{ ok: boolean; error?: string }> {
  const order = await getOrder(context, orderId);
  if (!order) return { ok: false, error: "订单不存在" };
  if (order.status !== "reserved") {
    return { ok: false, error: "该订单当前不能自助退款" };
  }
  if (order.userId !== user.id) {
    return { ok: false, error: "只有下单账号本人能退款到余额" };
  }

  // 先抢占迁移再入账。applyEvent 的条件更新保证并发下只有一个请求能把
  // reserved → refunded —— 输掉竞态的一方在这里拿到失败，绝不会再入账。
  // 反过来的顺序（先入账后迁移）在并发下会让余额加两次。
  // 抢到后入账失败是罕见场景（DB 抖动）：状态已终态、事件日志可查，
  // 人工补一笔流水即可 —— 比客户多得一笔钱好处理。
  const claimed = await applyEvent(context, order, { type: "refund_completed" });
  if (!claimed.ok) {
    return { ok: false, error: claimed.reason ?? "退款失败，请勿重复提交" };
  }

  const credited = await ledger.postWithRetry(context, {
    userId: user.id,
    kind: "refund",
    amount: order.payAmount ?? order.priceTotal,
    orderId: order.id,
    note: `预订单退款：${order.productName}`,
  });
  if (!credited.ok) {
    // 迁移已成功但入账失败 —— 不回滚状态（回滚需要再迁移一次，引入更多
    // 竞态），记录在事件流里等人工补账。返回成功让客户不重复点。
    return { ok: true };
  }
  return { ok: true };
}

/**
 * 人工发货：店主把手动买到的卡密录入系统（fulfillment.mode=manual 的主路径，
 * 也是预订单补货后的手动交付）。带幂等 —— 同一订单重复录入会拒绝，
 * 绝不静默覆盖已交付的卡密。
 */
export async function manualFulfill(
  context: DaichongContext,
  orderId: string,
  secret: string,
  leaveMessage?: string,
): Promise<{ ok: boolean; error?: string }> {
  const order = await getOrder(context, orderId);
  if (!order) return { ok: false, error: "订单不存在" };
  if (!secret.trim()) return { ok: false, error: "卡密不能为空" };

  const result = await applyEvent(
    context,
    order,
    { type: "manual_delivery", secret: secret.trim() },
    {
      secret: secret.trim(),
      ...(leaveMessage ? { leaveMessage } : {}),
      supplierTradeNo: order.supplierTradeNo,
    },
  );
  if (!result.ok) return { ok: false, error: result.reason ?? "发货失败" };
  return { ok: true };
}

/**
 * 管理员退款：把已付款但发不了货的订单退到客户余额。
 *
 * 与自助退款（refundReservationToBalance）的差别在准入：管理员可以退
 * procurement_failed / needs_review —— 那些是「我们欠客户一笔退款」的状态。
 * 匿名订单没有余额可退，由调用方提示走线下。
 */
export async function applyAdminRefund(
  context: DaichongContext,
  order: Order,
): Promise<{ ok: boolean; error?: string }> {
  if (
    order.status !== "procurement_failed" &&
    order.status !== "needs_review" &&
    order.status !== "reserved"
  ) {
    return { ok: false, error: `状态 ${order.status} 不在可退款范围内` };
  }
  if (!order.userId) {
    return { ok: false, error: "匿名订单无账号余额，请线下退款" };
  }

  // 与自助退款同样的顺序论证：先抢占迁移（条件更新挡并发），再入账。
  const claimed = await applyEvent(context, order, { type: "refund_completed" });
  if (!claimed.ok) {
    return { ok: false, error: claimed.reason ?? "退款失败" };
  }

  const credited = await ledger.postWithRetry(context, {
    userId: order.userId,
    kind: "refund",
    amount: order.payAmount ?? order.priceTotal,
    orderId: order.id,
    note: `管理员退款：${order.productName}`,
  });
  if (!credited.ok) {
    // 迁移已生效但入账失败：事件日志可查，人工补账。绝不向客户暴露半途状态。
    return { ok: true };
  }
  return { ok: true };
}

/**
 * 预订单续履约：目录同步发现补货后，把排队中的预订单推回进货流程。
 *
 * 只在 fulfillment.mode=auto 时自动执行 —— manual 模式下店主应当通过
 * admin 订单列表人工确认（他可能想自己先去上游买）。库存判断用同步后的
 * 本地快照：这是「补了货」的信号，真正的库存校验在进货那一步还会做。
 */
export async function resumeReservations(
  context: DaichongContext,
): Promise<number> {
  if (context.config.fulfillment.mode !== "auto") return 0;

  const pending = await context.db
    .select()
    .from(orders)
    .where(eq(orders.status, "reserved"));

  let resumed = 0;
  for (const order of pending) {
    const product = await findProduct(context, order.supplierId, order.productCode, order.race);
    if (!product || product.stock < order.quantity) continue;

    const result = await fulfillOrder(context, order);
    if (result.ok) resumed += 1;
  }
  return resumed;
}

/** 管理视图：按状态列订单，人工发货/退款待办就从这里看。 */
export async function listOrders(
  context: DaichongContext,
  options: { status?: OrderStatus; limit?: number } = {},
): Promise<Order[]> {
  const rows = await context.db
    .select()
    .from(orders)
    .where(
      options.status
        ? eq(orders.status, options.status)
        : sql`${orders.status} in ('paid','reserved','needs_review','procurement_failed')`,
    )
    .orderBy(sql`${orders.createdAt} desc`)
    .limit(options.limit ?? 100);
  return rows;
}
