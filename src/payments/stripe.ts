/**
 * Stripe Checkout（托管收银台）对接 —— 纯 REST，不引 SDK。
 *
 * 为什么用 Checkout 而不是自建表单 + Elements：
 *   - 卡数据完全不经过我们的服务器，PCI 合规压力为零；
 *   - 一个托管页自带 卡 / Apple Pay / Google Pay / 支付宝 / 微信支付；
 *   - 3DS 验证、风控、拒付申诉都是 Stripe 的事。
 *
 * 对账模型（和链上「唯一金额」完全不同，别混着想）：
 *   - 订单号 = Checkout Session 的 client_reference_id + metadata.order_id；
 *   - 到账判定 = webhook `checkout.session.completed`（验签后置为已付款）；
 *   - 兜底 = 客户支付后回到订单页，用 session id 向 Stripe 反查状态
 *     （webhook 偶发延迟时，回访页面也能立刻点亮订单）。
 *
 * 金额口径：店铺结算币是 USDT（≈USD 1:1），Stripe 以 USD 收款，
 * 金额 = 订单 USDT 金额取美分。汇率波动导致的 ±0.5% 内差异由
 * 20% 的默认加价覆盖，不做二次换汇。
 */

const API = "https://api.stripe.com/v1";

export interface StripeSession {
  id: string;
  url: string;
  payment_status?: string;
  status?: string;
}

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

/** 创建 Checkout Session，返回托管收银台跳转地址。 */
export async function createCheckoutSession(input: {
  secretKey: string;
  orderId: string;
  /** 收款金额（主币种单位的字符串，如 "20.76"）。 */
  amount: string;
  currency: string;
  productName: string;
  quantity: number;
  /** 可空：Stripe 的 customer_email 是可选字段，空值直接不带。 */
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  /** 会话有效期（秒）。Stripe 强制下限 30 分钟。 */
  expiresAt: number;
}): Promise<{ ok: true; session: StripeSession } | { ok: false; error: string }> {
  // 金额换算成最小单位（美分）：整数运算，不吃浮点误差。
  const [whole = "", frac = ""] = input.amount.split(".");
  const frac2 = (frac + "00").slice(0, 2);
  if (!/^-?\d+$/.test(whole) || !/^\d{0,2}$/.test(frac) && frac.length > 0) {
    return { ok: false, error: "金额不合法" };
  }
  const cents = BigInt(whole) * 100n + BigInt(frac2);
  if (cents <= 0n) return { ok: false, error: "金额不合法" };

  const fields: Record<string, string> = {
    mode: "payment",
    client_reference_id: input.orderId,
    "metadata[order_id]": input.orderId,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: String(input.expiresAt),
    "line_items[0][quantity]": String(input.quantity),
    "line_items[0][price_data][currency]": input.currency,
    "line_items[0][price_data][unit_amount]": cents.toString(),
    "line_items[0][price_data][product_data][name]": input.productName.slice(0, 200),
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "alipay",
    "payment_method_types[2]": "wechat_pay",
  };

  const response = await fetch(`${API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formEncode(fields),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!response.ok || !payload.id || !payload.url) {
    return { ok: false, error: payload.error?.message ?? `Stripe HTTP ${response.status}` };
  }
  return { ok: true, session: { id: payload.id, url: payload.url } };
}

/** 支付回跳后反查会话状态（webhook 延迟时的兜底确认）。 */
export async function retrieveSession(
  secretKey: string,
  sessionId: string,
): Promise<StripeSession | null> {
  const response = await fetch(`${API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as StripeSession;
  return payload.id ? payload : null;
}

/**
 * 校验 Stripe webhook 签名（Stripe-Signature 头，t=时间戳,v1=HMAC）。
 *
 * 实现 Stripe 官方算法：对 `${t}.${原始请求体}` 做 HMAC-SHA256 后与 v1
 * 常量时间比较，并拒绝超过 5 分钟的旧时间戳（防重放）。
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: "missing signature header" };

  const parts = header.split(",").reduce<Record<string, string[]>>((acc, part) => {
    const [key, value] = part.split("=");
    if (!key || !value) return acc;
    (acc[key.trim()] ??= []).push(value.trim());
    return acc;
  }, {});
  const t = parts.t?.[0];
  const v1 = parts.v1 ?? [];
  if (!t || v1.length === 0) return { ok: false, reason: "malformed signature header" };

  // 5 分钟重放窗口，与官方 SDK 默认一致。
  const age = Math.abs(now - Number(t) * 1000);
  if (!Number.isFinite(age) || age > 5 * 60_000) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${t}.${payload}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  // 常量时间比较：逐字节异或累积，避免提前返回泄露前缀匹配信息。
  let diff = 0;
  for (const candidate of v1) {
    if (candidate.length !== expected.length) {
      diff = 1;
      continue;
    }
    let local = 0;
    for (let i = 0; i < expected.length; i += 1) {
      local |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
    }
    if (local === 0) return { ok: true };
    diff = 1;
  }
  return { ok: false, reason: diff === 1 ? "signature mismatch" : "signature mismatch" };
}

/** 解析 webhook 事件里我们关心的最小字段。 */
export interface CheckoutCompleted {
  orderId: string;
  sessionId: string;
  paymentStatus: string;
}

export function parseCheckoutCompleted(event: {
  type?: string;
  data?: { object?: { id?: string; client_reference_id?: string; payment_status?: string; metadata?: { order_id?: string } } };
}): CheckoutCompleted | null {
  if (event.type !== "checkout.session.completed") return null;
  const session = event.data?.object;
  const orderId = session?.metadata?.order_id || session?.client_reference_id;
  if (!session?.id || !orderId) return null;
  return {
    orderId,
    sessionId: session.id,
    paymentStatus: session.payment_status ?? "unknown",
  };
}
