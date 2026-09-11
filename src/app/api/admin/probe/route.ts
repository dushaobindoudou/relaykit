/**
 * 上游连通性探针。
 *
 * 排查「本机能访问但线上访问不了」这类问题 —— 这类问题相当常见：
 * 上游的 WAF 常按 IP 段拦截数据中心流量，而 Cloudflare 的出口正在其中。
 * 本机 curl 一切正常，线上却一直取不到数据。
 *
 * **只允许探测配置里已有的上游域名**，避免把它变成一个开放代理。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { buildContext, type Bindings } from "@/runtime/context";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const bindings: Bindings = env;

  const expected = bindings.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") {
    return Response.json({ ok: false, error: "未设置 ADMIN_TOKEN" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = buildContext(bindings);
  if (!result.ok || !result.context) {
    return Response.json({ ok: false, error: result.error }, { status: 503 });
  }

  const target = new URL(request.url).searchParams.get("url") ?? "";
  const allowedHosts = new Set(
    result.context.config.suppliers
      .filter((supplier) => supplier.domain)
      .map((supplier) => new URL(supplier.domain!).host),
  );

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ ok: false, error: "url 不合法" }, { status: 400 });
  }
  if (!allowedHosts.has(parsed.host)) {
    return Response.json(
      { ok: false, error: `只允许探测已配置的上游域名：${[...allowedHosts].join(", ")}` },
      { status: 400 },
    );
  }

  // POST 探测用：对接接口（/shared/*）只接受 POST，而它是否也在 WAF 闸后
  // 决定了我们是走公开目录抓取还是走官方对接。
  const method = new URL(request.url).searchParams.get("method") === "POST" ? "POST" : "GET";
  // 与下方响应体的 body 区分开：重名会让 fetch 选项里的 body 指向尚未初始化的那个。
  const postBody = new URL(request.url).searchParams.get("body") ?? "";

  // 几组不同的请求特征，用来区分「IP 被拦」与「请求特征被拦」。
  const variants: { name: string; headers: Record<string, string> }[] = [
    { name: "bare", headers: {} },
    {
      name: "browser",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Referer: `${parsed.origin}/`,
      },
    },
    {
      name: "xhr",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        Referer: `${parsed.origin}/`,
      },
    },
  ];

  const attempts = [];
  for (const variant of variants) {
    try {
      const response = await fetch(target, {
        method,
        headers:
          method === "POST"
            ? { ...variant.headers, "Content-Type": "application/x-www-form-urlencoded" }
            : variant.headers,
        ...(method === "POST" ? { body: postBody } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      attempts.push({
        variant: variant.name,
        status: response.status,
        server: response.headers.get("server"),
        contentType: response.headers.get("content-type"),
        bodyPrefix: body.slice(0, 160),
      });
    } catch (error) {
      attempts.push({
        variant: variant.name,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json({ ok: true, target, attempts });
}
