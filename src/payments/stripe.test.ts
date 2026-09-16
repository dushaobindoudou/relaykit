/**
 * Stripe 对接测试：金额换算、webhook 验签（含重放与篡改）、
 * 事件解析、会话创建的表单字段。
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createCheckoutSession,
  parseCheckoutCompleted,
  verifyStripeSignature,
} from "@/payments/stripe";

describe("createCheckoutSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("金额换算成美分且字段齐全（订单号双写）", async () => {
    let captured = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: { body: string }) => {
        captured = init.body;
        return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/x" });
      }),
    );

    const result = await createCheckoutSession({
      secretKey: "sk_test_x",
      orderId: "AB12-CD34",
      amount: "20.76",
      currency: "usd",
      productName: "GPT PLUS 年卡",
      quantity: 2,
      customerEmail: "a@b.c",
      successUrl: "https://shop.example.com/orders/AB12-CD34?stripe=return",
      cancelUrl: "https://shop.example.com/orders/AB12-CD34?stripe=cancel",
      expiresAt: 1900000000,
    });

    expect(result.ok).toBe(true);
    const params = new URLSearchParams(captured);
    expect(params.get("mode")).toBe("payment");
    expect(params.get("client_reference_id")).toBe("AB12-CD34");
    expect(params.get("metadata[order_id]")).toBe("AB12-CD34");
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("2076");
    expect(params.get("line_items[0][quantity]")).toBe("2");
    expect(params.get("payment_method_types[0]")).toBe("card");
    expect(params.get("payment_method_types[1]")).toBe("alipay");
    expect(params.get("payment_method_types[2]")).toBe("wechat_pay");
  });

  test("金额不合法直接拒绝，不打 Stripe API", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await createCheckoutSession({
      secretKey: "sk_test_x",
      orderId: "X",
      amount: "0",
      currency: "usd",
      productName: "p",
      quantity: 1,
      customerEmail: null,
      successUrl: "https://s/x",
      cancelUrl: "https://s/y",
      expiresAt: 1900000000,
    });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("verifyStripeSignature", () => {
  const SECRET = "whsec_test_secret";
  const Payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  async function makeHeader(payload: string, secret: string, secondsAgo = 0): Promise<string> {
    const t = Math.floor((Date.now() - secondsAgo * 1000) / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
    const v1 = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${t},v1=${v1}`;
  }

  test("合法签名通过", async () => {
    const header = await makeHeader(Payload, SECRET);
    const result = await verifyStripeSignature(Payload, header, SECRET);
    expect(result.ok).toBe(true);
  });

  test("密钥错误 → 拒绝", async () => {
    const header = await makeHeader(Payload, "whsec_other");
    const result = await verifyStripeSignature(Payload, header, SECRET);
    expect(result).toEqual({ ok: false, reason: "signature mismatch" });
  });

  test("请求体被篡改 → 拒绝", async () => {
    const header = await makeHeader(Payload, SECRET);
    const tampered = Payload.replace("completed", "charge.refunded");
    const result = await verifyStripeSignature(tampered, header, SECRET);
    expect(result.ok).toBe(false);
  });

  test("超过 5 分钟的旧签名 → 拒绝（防重放）", async () => {
    const header = await makeHeader(Payload, SECRET, 600);
    const result = await verifyStripeSignature(Payload, header, SECRET);
    expect(result).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  test("缺少签名头 → 拒绝", async () => {
    const result = await verifyStripeSignature(Payload, null, SECRET);
    expect(result.ok).toBe(false);
  });
});

describe("parseCheckoutCompleted", () => {
  test("completed + paid → 取出订单号与 session id", () => {
    const result = parseCheckoutCompleted({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          client_reference_id: "AB12-CD34",
          payment_status: "paid",
          metadata: { order_id: "AB12-CD34" },
        },
      },
    });
    expect(result).toEqual({ orderId: "AB12-CD34", sessionId: "cs_1", paymentStatus: "paid" });
  });

  test("其他事件类型 → null", () => {
    expect(parseCheckoutCompleted({ type: "charge.refunded" })).toBeNull();
  });

  test("缺订单号（metadata 与 reference 都没有）→ null，绝不误发货", () => {
    expect(
      parseCheckoutCompleted({
        type: "checkout.session.completed",
        data: { object: { id: "cs_2", payment_status: "paid" } },
      }),
    ).toBeNull();
  });
});
