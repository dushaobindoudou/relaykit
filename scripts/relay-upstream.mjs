#!/usr/bin/env node
/**
 * 上游 WAF 中继 —— 自动中转采购的"另一条腿"。
 *
 * 背景：zhanghao66.com 的 WAF 拦截 Cloudflare Workers 的出口 IP（HTTP 456），
 * Worker 里跑的自动采购没法直连上游。这个脚本部署在**任何不被拦的位置**
 * （自有 VPS、家用小主机、Deno Deploy 等），把 Worker 的上游请求转发过去。
 *
 * 用法：
 *   RELAY_SECRET=请生成一个长随机字符串 node scripts/relay-upstream.mjs
 *   # 然后在 buyrelay.config.yaml 里配置
 *   #   suppliers[0].relayUrl: "https://<你的中继域名>"
 *   # 并把同一个 RELAY_SECRET `wrangler secret put RELAY_SECRET`。
 *
 * 协议：
 *   GET/POST <relay>/?url=<encodeURIComponent(上游绝对地址)>
 *   头：X-Relay-Secret: <RELAY_SECRET>
 *   请求体原样透传（form/JSON 均可），响应原样回传（含 status/content-type）。
 *
 * 安全：仅转发允许的目标域（ALLOWED_HOSTS，默认上游域名），密钥不对就 403。
 * 这不是公共代理 —— 不要把没有密钥校验的版本挂到公网上。
 */

import http from "node:http";

const PORT = Number(process.env.RELAY_PORT ?? 8791);
const SECRET = process.env.RELAY_SECRET;
const ALLOWED_HOSTS = (process.env.RELAY_ALLOWED_HOSTS ?? "zhanghao66.com")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

if (!SECRET) {
  console.error("必须设置 RELAY_SECRET（生成：node -e \"console.log(crypto.randomUUID())\"）");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers["x-relay-secret"] !== SECRET) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }

    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const target = requestUrl.searchParams.get("url");
    if (!target) {
      res.writeHead(400).end("missing ?url=");
      return;
    }
    const upstream = new URL(target);
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
      res.writeHead(400).end("bad protocol");
      return;
    }
    if (!ALLOWED_HOSTS.includes(upstream.host)) {
      res.writeHead(403).end(`host not allowed: ${upstream.host}`);
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["x-relay-secret"];
    delete headers["content-length"];

    const response = await fetch(upstream, {
      method: req.method,
      headers,
      ...(body.length > 0 ? { body } : {}),
      redirect: "follow",
    });

    const responseHeaders = Object.fromEntries(response.headers.entries());
    res.writeHead(response.status, responseHeaders);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`relay error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}, allowed hosts: ${ALLOWED_HOSTS.join(", ")}`);
});
