/**
 * 本地假上游：复刻 acg-faka 共享店铺协议，供适配器测试与联调使用。
 *
 * 之所以要自己写一个而不是直接打真站：
 *   1. 拿到 app_id/app_key 之前，全链路（收款→进货→发货）没法端到端跑；
 *   2. 丢钱路径（下单超时但上游已扣款）在真站上没法复现 —— 总不能为了测试
 *      故意打一堆真实订单；
 *   3. 真站的余额是真钱。
 *
 * 行为刻意对齐上游源码，包括那些**反直觉的部分**，尤其是：
 *   - 重复 request_no 是抛错，不是回放原订单（Service/Bind/Order.php）
 *   - HTTP 状态码恒为 200，成败只看 body 里的 code
 *   - 先查 app_id 再验签，两者报错不同（Interceptor/SharedValidation.php）
 * 假上游如果比真上游"友好"，测试就会给出虚假的安全感。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
// 必须是 import type：AddressInfo 只是类型，剥离模式不会把它从 import 里摘掉，
// 运行时会去 node:net 上找这个并不存在的具名导出。
import type { AddressInfo } from "node:net";

import { generateSignature, type SignPayload } from "./signature";

export interface MockProduct {
  code: string;
  name: string;
  /** 规格名 → 标价。单规格商品用空字符串作为唯一的键。 */
  listPrice: Record<string, string>;
  /** 规格名 → 我们的拿货价。 */
  factoryPrice: Record<string, string>;
  stock: number;
}

export interface MockUpstreamOptions {
  appId: string;
  appKey: string;
  products: MockProduct[];
  currencyCode?: string;
  initialBalance?: string;
}

interface MockOrder {
  tradeNo: string;
  requestNo: string;
  secret: string;
}

/**
 * 故障注入开关。测试通过它模拟那些在真站上无法安全复现的情况。
 */
export interface FaultInjection {
  /** trade 收到请求、**处理完成后**再挂断连接 —— 精确复现"已扣款但客户端没收到答复"。 */
  tradeHangUpAfterCommit?: boolean;
  /** trade 直接不响应，触发客户端超时。 */
  tradeNeverRespond?: boolean;
  /** 下一次 trade 返回指定的业务错误。 */
  tradeRejectWith?: string;
  /** 返回 WAF 拦截页之类的非 JSON 响应。 */
  respondWithGarbage?: boolean;
  /** trade 正常落单并返回 200，但 body 里缺 tradeNo —— 卡发得出去却对不了账。 */
  tradeOmitTradeNo?: boolean;
}

export class MockUpstream {
  readonly faults: FaultInjection = {};

  #server: Server | undefined;
  #balance: number;
  #orders = new Map<string, MockOrder>();
  #tradeSeq = 0;

  // 显式字段而非构造函数参数属性 —— Node 的类型剥离不支持后者。
  readonly #options: MockUpstreamOptions;

  constructor(options: MockUpstreamOptions) {
    this.#options = options;
    this.#balance = Number(options.initialBalance ?? "1000");
  }

  get balance(): number {
    return this.#balance;
  }

  /** 已落单的 request_no 集合，测试用来断言"到底扣没扣款"。 */
  get committedRequestNos(): string[] {
    return [...this.#orders.values()].map((order) => order.requestNo);
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });

    await new Promise<void>((resolve) => {
      this.#server!.listen(0, "127.0.0.1", resolve);
    });

    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));

    const json = (code: number, msg: string, data: unknown = {}): void => {
      // 真上游无论成败都回 HTTP 200，这里必须一致 —— 否则客户端可能误用状态码判断。
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code, msg, data }));
    };

    if (this.faults.respondWithGarbage) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>WAF blocked</body></html>");
      return;
    }

    // —— 鉴权：顺序与 SharedValidation 一致，先 app_id 后签名 ——
    if (params.get("app_id") !== this.#options.appId) {
      json(0, "商户ID不存在");
      return;
    }

    const payload: SignPayload = {};
    for (const [key, value] of params.entries()) {
      if (key !== "sign") payload[key] = value;
    }

    if (generateSignature(payload, this.#options.appKey) !== params.get("sign")) {
      json(0, "密钥错误");
      return;
    }

    const path = (req.url ?? "").split("?")[0] ?? "";
    const product = this.#options.products.find(
      (item) => item.code === (params.get("code") ?? params.get("shared_code")),
    );
    const currencyCode = this.#options.currencyCode ?? "CNY";

    switch (true) {
      case path === "/shared/authentication/connect":
        json(200, "success", {
          shopName: "mock-shop",
          balance: this.#balance.toFixed(2),
        });
        return;

      case path === "/shared/commodity/items":
        json(200, "success", [
          {
            id: 1,
            name: "mock-category",
            children: this.#options.products.map((item) => this.#serialize(item)),
          },
        ]);
        return;

      case path === "/shared/commodity/item":
        if (!product) return json(0, "商品不存在");
        json(200, "success", this.#serialize(product));
        return;

      case path === "/shared/commodity/stock":
        if (!product) return json(0, "商品不存在");
        json(200, "success", { stock: product.stock });
        return;

      case path === "/shared/commodity/valuation": {
        if (!product) return json(0, "商品不存在#0");
        const race = params.get("race") ?? "";
        const unit = product.factoryPrice[race] ?? product.factoryPrice[""] ?? "0";
        const quantity = Number(params.get("num") ?? "1") || 1;
        json(200, "success", {
          price: (Number(unit) * quantity).toFixed(2),
          currency_code: currencyCode,
        });
        return;
      }

      case path === "/shared/commodity/trade":
        await this.#handleTrade(params, product, json, res);
        return;

      case path.startsWith("/shared/commodity/query/"): {
        const tradeNo = decodeURIComponent(path.slice("/shared/commodity/query/".length));
        const order = [...this.#orders.values()].find((it) => it.tradeNo === tradeNo);
        if (!order) return json(0, "订单不存在");
        json(200, "success", { secret: order.secret, widget: null, status: 1 });
        return;
      }

      default:
        json(0, "接口不存在");
    }
  }

  async #handleTrade(
    params: URLSearchParams,
    product: MockProduct | undefined,
    json: (code: number, msg: string, data?: unknown) => void,
    res: ServerResponse,
  ): Promise<void> {
    if (this.faults.tradeNeverRespond) {
      // 不回复也不关闭，让客户端自己超时。
      return;
    }

    if (this.faults.tradeRejectWith) {
      json(0, this.faults.tradeRejectWith);
      return;
    }

    if (!product) return json(0, "商品不存在");

    const requestNo = params.get("request_no") ?? "";

    // 与 Service/Bind/Order.php 一致：重复的 request_no **抛错**，不回放原订单。
    // 这行是整个协议里最贵的一行，假上游必须照抄。
    if (requestNo && this.#orders.has(requestNo)) {
      json(0, "The request ID already exists");
      return;
    }

    const race = params.get("race") ?? "";
    const quantity = Number(params.get("num") ?? "1") || 1;
    const unit = Number(product.factoryPrice[race] ?? product.factoryPrice[""] ?? "0");
    const amount = unit * quantity;

    if (product.stock < quantity) return json(0, "库存不足");
    if (this.#balance < amount) return json(0, "余额不足");

    // —— 落单：扣余额、扣库存、生成卡密 ——
    this.#balance -= amount;
    product.stock -= quantity;
    this.#tradeSeq += 1;
    const tradeNo = `MOCK${String(this.#tradeSeq).padStart(6, "0")}`;
    const order: MockOrder = {
      tradeNo,
      requestNo,
      secret: `SECRET-${tradeNo}-${product.code}`,
    };
    this.#orders.set(requestNo, order);

    if (this.faults.tradeHangUpAfterCommit) {
      // 关键：**提交之后**才挂断。客户端拿不到答复，但钱已经扣了、卡已经分配了。
      // 这正是 resolveAmbiguous 要处理的那个状态。
      res.destroy();
      return;
    }

    json(200, "success", {
      ...(this.faults.tradeOmitTradeNo ? {} : { tradeNo }),
      secret: order.secret,
      amount: amount.toFixed(2),
      leave_message: "mock-leave-message",
    });
  }

  #serialize(product: MockProduct): Record<string, unknown> {
    const races = Object.keys(product.listPrice).filter((race) => race !== "");

    if (races.length === 0) {
      return {
        code: product.code,
        name: product.name,
        price: product.listPrice[""] ?? "0",
        factory_price: product.factoryPrice[""] ?? "0",
        stock: product.stock,
        config: {},
      };
    }

    return {
      code: product.code,
      name: product.name,
      price: product.listPrice[races[0]!] ?? "0",
      stock: product.stock,
      config: {
        category: product.listPrice,
        category_factory: product.factoryPrice,
      },
    };
  }
}
