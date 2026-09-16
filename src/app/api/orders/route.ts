/** 创建订单。店面下单表单唯一的写入口。 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { resolveSession, SESSION_COOKIE } from "@/accounts/auth";
import { createOrder } from "@/orders/service";
import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

interface Payload {
  payMethod?: unknown;
  couponCode?: unknown;
  supplierId?: unknown;
  code?: unknown;
  race?: unknown;
  quantity?: unknown;
  chainId?: unknown;
  contactEmail?: unknown;
  queryPassword?: unknown;
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function POST(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const result = buildContext(env satisfies Bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: "店铺配置异常，暂时无法下单" }, { status: 503 });
  }

  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return Response.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }

  const email = str(body.contactEmail);
  const password = str(body.queryPassword);

  // 校验在服务端重做一遍：客户端的 required/minLength 只是体验，不是防线。
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ ok: false, error: "请填写有效的邮箱" }, { status: 400 });
  }
  if (password.length < 4) {
    return Response.json({ ok: false, error: "订单口令至少 4 位" }, { status: 400 });
  }

  // 登录用户下单时把订单挂到账号上，"我的订单"才看得到。
  const user = await resolveSession(
    result.context,
    (await cookies()).get(SESSION_COOKIE)?.value,
  );

  // payMethod 原样下传：chain/balance 之外视为手动收款渠道 id，
  // createOrder 会对照配置校验，未知渠道直接拒绝。
  const payMethod = str(body.payMethod) ?? "chain";
  const couponCode = str(body.couponCode);

  const created = await createOrder(result.context, {
    supplierId: str(body.supplierId),
    code: str(body.code),
    race: str(body.race),
    quantity: Number(body.quantity) || 1,
    chainId: str(body.chainId),
    contactEmail: email,
    queryPassword: password,
    payMethod,
    // Stripe 渠道可用性由 createOrder 校验；密钥只经内存传递，绝不落库/日志。
    ...(env.STRIPE_SECRET_KEY ? { stripeSecretKey: env.STRIPE_SECRET_KEY } : {}),
    user,
    ...(couponCode ? { couponCode } : {}),
  });

  if (!created.ok) {
    return Response.json({ ok: false, error: created.error }, { status: 400 });
  }

  return Response.json({ ok: true, orderId: created.order.id });
}
