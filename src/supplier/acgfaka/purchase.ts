/**
 * acg-faka 上游的**游客购买**客户端 —— 自动中转采购的核心。
 *
 * 与 client.ts（需要 app_id/app_key 的代理协议）、public.ts（只读目录）的
 * 区别：这一条是「我们假装成上游的普通客户」——用他们前台的公开接口下单、
 * 付款、收货。逆向自 zhanghao66.com（ACG发卡 v3.6.0 Tokyo 主题）的前台 JS
 * 与收银台页面，全部端点都在 2026-09-14 实测过：
 *
 *   GET  /item/{id}                     商品页，内嵌 order_confirm_hash
 *   GET  /user/api/index/pay?itemId=    支付通道列表（6=USDT-polygon 等）
 *   POST /user/api/order/trade          下单 → {tradeNo, amount, url}
 *   GET  /plugin/usdt/order/trade?...   USDT 收银台（地址+精确金额+链名）
 *   POST /plugin/usdt/api/query         USDT 到账轮询（status 0→1）
 *   POST /user/api/index/query          订单列表（keywords=tradeNo）
 *   POST /user/api/index/secret         取卡密（无查询密码时 password 传空）
 *
 * 风险边界：游客下单没有任何凭据，上游改版会直接断 —— 所以每个解析点
 * 都要有明确的错误信息，断的时候能一眼看出是哪一步、页面长什么样。
 */

export interface AcgFakaPurchaseConfig {
  domain: string;
  timeoutMs?: number;
  /**
   * WAF 中继地址。
   *
   * 上游对 Cloudflare Workers 的出口 IP 返回 456 拦截页（见
   * docs/upstream-access.md）。Worker 上自动采购时，所有上游请求改走
   * 中继：`${relayUrl}?url=<encoded 上游绝对地址>`，鉴权头 X-Relay-Secret。
   * 本地/自有服务器直连时留空。
   */
  relayUrl?: string;
  relaySecret?: string;
}

export interface PayChannel {
  id: number;
  name: string;
  handle: string;
}

export interface UpstreamTrade {
  tradeNo: string;
  /** 上游口径的人民币金额（批发价已生效）。 */
  amountCny: string;
  /** 收银台路径，需要拼上游域名访问。 */
  payPath: string;
}

export interface UpstreamPayment {
  /** 收银台标注的链名，如 "Polygon"、"BEP20"。 */
  chainLabel: string;
  address: string;
  /** 精确到上游小数位的 USDT 金额字符串，如 "2.498"。必须原样支付。 */
  amountUsdt: string;
}

export interface UpstreamOrderRow {
  tradeNo: string;
  status: number;
  deliveryStatus: number;
  amountCny: string;
  cardNum: number;
  contact: string;
}

export class UpstreamTradeError extends Error {
  readonly code = 0;
  constructor(
    message: string,
    readonly kind: "minimum_amount" | "sold_out" | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "UpstreamTradeError";
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class AcgFakaPurchaseClient {
  readonly #domain: string;
  readonly #timeoutMs: number;
  readonly #relayUrl: string | null;
  readonly #relaySecret: string | null;
  /** 极简 cookie 罐：上游用 cookie 做会话/频控，带着总没错。 */
  readonly #cookies = new Map<string, string>();

  constructor(config: AcgFakaPurchaseConfig) {
    this.#domain = config.domain.replace(/\/+$/, "");
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    this.#relayUrl = config.relayUrl?.replace(/\/+$/, "") || null;
    this.#relaySecret = config.relaySecret ?? null;
  }

  #targetUrl(path: string): string {
    return path.startsWith("http") ? path : `${this.#domain}${path}`;
  }

  async #request(
    path: string,
    init: {
      method: "GET" | "POST";
      form?: Record<string, string>;
      referer?: string;
      accept?: string;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      "X-Requested-With": "XMLHttpRequest",
      Accept: init.accept ?? "application/json, text/html, */*",
    };
    if (init.referer) headers.Referer = init.referer;

    let body: string | undefined;
    if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      body = new URLSearchParams(init.form).toString();
    }
    if (this.#cookies.size > 0) {
      headers.Cookie = [...this.#cookies.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    const target = this.#targetUrl(path);
    // 中继模式：上游请求全部改道，上游地址放进 query，密钥放头里。
    const requestUrl = this.#relayUrl
      ? `${this.#relayUrl}?url=${encodeURIComponent(target)}`
      : target;
    if (this.#relayUrl && this.#relaySecret) {
      headers["X-Relay-Secret"] = this.#relaySecret;
    }

    const response = await fetch(requestUrl, {
      method: init.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  }

  async #postForm<T>(path: string, form: Record<string, string>, referer: string): Promise<T> {
    const response = await this.#request(path, { method: "POST", form, referer });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    const payload = (await response.json()) as { code?: number; msg?: string; data?: T };
    if (payload.code !== 200) {
      throw new UpstreamTradeError(payload.msg ?? "上游拒绝", "unknown");
    }
    return payload.data as T;
  }

  /** 拉商品页 HTML（confirm hash 的来源）。 */
  async fetchItemHtml(itemId: string): Promise<string> {
    const response = await this.#request(`/item/${encodeURIComponent(itemId)}`, {
      method: "GET",
      accept: "text/html",
    });
    if (!response.ok) throw new Error(`/item/${itemId} HTTP ${response.status}`);
    return response.text();
  }

  /**
   * 从商品页 HTML 解出下单确认条款的哈希与开关。
   * 服务端强校验：order_confirm_status=1 时 trade 必须带
   * order_confirm_agree=1 + order_confirm_hash，缺了直接拒绝。
   */
  extractConfirm(html: string): { required: boolean; hash: string } {
    const status = /"order_confirm_status":\s*(\d+)/.exec(html);
    const hash = /"order_confirm_hash":"([0-9a-f]+)"/.exec(html);
    return {
      required: status?.[1] === "1",
      hash: hash?.[1] ?? "",
    };
  }

  async listPayChannels(itemId: string): Promise<PayChannel[]> {
    const data = await this.#postForm<PayChannel[]>(
      `/user/api/index/pay?itemId=${encodeURIComponent(itemId)}`,
      {},
      `${this.#domain}/item/${itemId}`,
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * 创建游客订单。金额不满足通道最低限额时抛 kind="minimum_amount"，
   * 调用方据此凑单（批量多买，余量进本地库存）。
   */
  async createTrade(input: {
    itemId: string;
    race: string;
    num: number;
    contact: string;
    payChannelId: number;
    confirm: { required: boolean; hash: string };
  }): Promise<UpstreamTrade> {
    const referer = `${this.#domain}/item/${input.itemId}`;
    const form: Record<string, string> = {
      item_id: input.itemId,
      num: String(input.num),
      contact: input.contact,
      pay_id: String(input.payChannelId),
      order_notice_confirmed: "1",
    };
    if (input.race) form.race = input.race;
    if (input.confirm.required) {
      form.order_confirm_agree = "1";
      form.order_confirm_hash = input.confirm.hash;
    }

    try {
      const data = await this.#postForm<{
        url?: string;
        tradeNo?: string;
        amount?: number | string;
      }>("/user/api/order/trade", form, referer);
      if (!data.tradeNo || !data.url) {
        throw new UpstreamTradeError("上游订单响应缺少 tradeNo/url");
      }
      return {
        tradeNo: data.tradeNo,
        amountCny: String(data.amount ?? ""),
        payPath: data.url,
      };
    } catch (error) {
      if (error instanceof UpstreamTradeError && /不满足.*(USDT|支付)/.test(error.message)) {
        throw new UpstreamTradeError(error.message, "minimum_amount");
      }
      if (error instanceof UpstreamTradeError && /(售罄|库存不足)/.test(error.message)) {
        throw new UpstreamTradeError(error.message, "sold_out");
      }
      throw error;
    }
  }

  /**
   * 解析 USDT 收银台：精确应付金额 + 收款地址 + 链名。
   * 上游按「金额完全一致」对账（少付多付都不发货），所以金额必须是
   * 原样字符串，绝不能自己重新换算。
   */
  async parseUsdtCashier(payPath: string): Promise<UpstreamPayment> {
    const response = await this.#request(payPath, {
      method: "GET",
      accept: "text/html",
      referer: this.#domain,
    });
    if (!response.ok) throw new Error(`收银台 HTTP ${response.status}`);
    const html = await response.text();

    const amount = /class="amount copyAmount"\s+data-clipboard-text="([0-9.]+)"/.exec(html)
      ?? /data-clipboard-text="([0-9.]+)"[^>]*>\s*[0-9.]+\s*<span>USDT/.exec(html);
    const address = /paymentAddress\s*=\s*['"]([0-9a-zA-Z]+)['"]/.exec(html);
    const chain = /class="address-label">([^<]+?)\s*收款地址/.exec(html);

    const amountValue = amount?.[1];
    const addressValue = address?.[1];
    if (!amountValue || !addressValue) {
      throw new Error(
        `收银台解析失败（可能已过期或改版）。快照前 400 字符：${html.slice(0, 400)}`,
      );
    }
    return {
      chainLabel: chain?.[1]?.trim() ?? "",
      address: addressValue,
      amountUsdt: amountValue,
    };
  }

  /** USDT 到账轮询：status 0=未到账 1=已到账。 */
  async queryPayment(tradeNo: string): Promise<{ status: number }> {
    const data = await this.#postForm<{ status?: number }>(
      "/plugin/usdt/api/query",
      { tradeNo },
      this.#domain,
    );
    return { status: Number(data.status ?? 0) };
  }

  /** 订单查询。找不到返回 null（可能已过期被清理）。 */
  async queryOrder(tradeNo: string): Promise<UpstreamOrderRow | null> {
    const data = await this.#postForm<{
      list?: {
        trade_no: string;
        status: number;
        delivery_status: number;
        amount: number | string;
        card_num: number;
        contact: string;
      }[];
    }>(
      "/user/api/index/query",
      { keywords: tradeNo, page: "1", limit: "10" },
      `${this.#domain}/user/index/query`,
    );
    const row = (data.list ?? []).find((item) => item.trade_no === tradeNo);
    if (!row) return null;
    return {
      tradeNo: row.trade_no,
      status: Number(row.status),
      deliveryStatus: Number(row.delivery_status),
      amountCny: String(row.amount ?? ""),
      cardNum: Number(row.card_num ?? 0),
      contact: row.contact ?? "",
    };
  }

  /** 取卡密。password_status=0 的商品空密码即可；已支付未发货会明确报错。 */
  async fetchSecret(
    tradeNo: string,
  ): Promise<{ secret: string; leaveMessage: string }> {
    const data = await this.#postForm<{
      secret?: string;
      leave_message?: string;
    }>(
      "/user/api/index/secret",
      { tradeNo, password: "" },
      `${this.#domain}/user/index/query`,
    );
    return { secret: data.secret ?? "", leaveMessage: data.leave_message ?? "" };
  }
}

/** 供 service 层把业务错误翻译成用户语言的类型收窄。 */
export function isMinimumAmountError(error: unknown): error is UpstreamTradeError {
  return error instanceof UpstreamTradeError && error.kind === "minimum_amount";
}
