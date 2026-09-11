/**
 * 内存假供货商 —— 演示与本地开发用，不发任何网络请求。
 *
 * 存在的理由是让 `git clone && pnpm dev` 立刻能看到一个完整可下单的店，
 * 不需要先去谈一个上游、不需要任何密钥、也不会花掉真钱。
 * 它同样实现 SupplierAdapter，所以走的是和真上游**完全相同**的代码路径：
 * 订单状态机、超时处理、毛利护栏都会被真实地跑到。
 */

import type {
  AmbiguityResolution,
  Decimal,
  PurchaseOutcome,
  PurchaseRequest,
  SupplierAdapter,
  SupplierProduct,
} from "@/supplier/types";

export interface MockAdapterOptions {
  /** 演示商品。留空则用内置的一组。 */
  products?: SupplierProduct[];
  initialBalance?: Decimal;
  /**
   * 人为制造的失败率（0~1），用于演示与压测订单状态机的异常分支。
   * 生产配置里不该出现非 0 值。
   */
  failureRate?: number;
  /** 注入随机源，测试里可替换成确定性函数。 */
  random?: () => number;
}

const DEMO_PRODUCTS: SupplierProduct[] = [
  {
    code: "DEMO-GEMINI-1Y",
    name: "Demo Pro Plan — 12 months",
    races: ["Standard", "Regional"],
    costByRace: { Standard: "30", Regional: "32" },
    listPriceByRace: { Standard: "48", Regional: "50" },
    stock: 120,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-ASSISTANT-1M",
    name: "Demo Assistant — 1 month",
    races: [],
    costByRace: { "": "16" },
    listPriceByRace: { "": "20" },
    stock: 40,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-OUT-OF-STOCK",
    name: "Demo Item — sold out",
    races: [],
    costByRace: { "": "10" },
    listPriceByRace: { "": "15" },
    stock: 0,
    currencyCode: "CNY",
  },
];

export class MockAdapter implements SupplierAdapter {
  readonly id = "mock";

  #balance: number;
  #products: Map<string, SupplierProduct>;
  #orders = new Map<string, { tradeNo: string; secret: string }>();
  #seq = 0;

  readonly #failureRate: number;
  readonly #random: () => number;

  constructor(options: MockAdapterOptions = {}) {
    this.#balance = Number(options.initialBalance ?? "5000");
    this.#failureRate = options.failureRate ?? 0;
    this.#random = options.random ?? Math.random;
    this.#products = new Map(
      (options.products ?? DEMO_PRODUCTS).map((item) => [item.code, { ...item }]),
    );
  }

  async connect(): Promise<{ shopName: string; balance: Decimal }> {
    return { shopName: "RelayKit Demo Supplier", balance: this.#balance.toFixed(2) };
  }

  async listProducts(): Promise<SupplierProduct[]> {
    return [...this.#products.values()].map((item) => ({ ...item }));
  }

  async getProduct(code: string): Promise<SupplierProduct> {
    const product = this.#products.get(code);
    if (!product) throw new Error(`商品不存在: ${code}`);
    return { ...product };
  }

  async getStock(code: string): Promise<number> {
    return this.#products.get(code)?.stock ?? 0;
  }

  async quote(code: string, quantity: number, race?: string): Promise<Decimal> {
    const product = await this.getProduct(code);
    const unit = product.costByRace[race ?? ""] ?? product.costByRace[""] ?? "0";
    return (Number(unit) * quantity).toFixed(2);
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    // 与真上游一致：重复的 requestNo 不回放结果，而是当作重复请求拒绝。
    // 演示环境也要保持这个行为，否则基于它开发的恢复逻辑会在真站上失效。
    if (this.#orders.has(request.requestNo)) {
      return { kind: "rejected", reason: "The request ID already exists", insufficientBalance: false };
    }

    if (this.#failureRate > 0 && this.#random() < this.#failureRate) {
      return {
        kind: "ambiguous",
        requestNo: request.requestNo,
        reason: "演示模式注入的随机超时",
      };
    }

    const product = this.#products.get(request.code);
    if (!product) {
      return { kind: "rejected", reason: "商品不存在", insufficientBalance: false };
    }
    if (product.stock < request.quantity) {
      return { kind: "rejected", reason: "库存不足", insufficientBalance: false };
    }

    const unit = Number(
      product.costByRace[request.race ?? ""] ?? product.costByRace[""] ?? "0",
    );
    const amount = unit * request.quantity;
    if (this.#balance < amount) {
      return { kind: "rejected", reason: "余额不足", insufficientBalance: true };
    }

    this.#balance -= amount;
    product.stock -= request.quantity;
    this.#seq += 1;
    const tradeNo = `DEMO${String(this.#seq).padStart(6, "0")}`;
    const secret = `DEMO-CODE-${tradeNo}`;
    this.#orders.set(request.requestNo, { tradeNo, secret });

    return {
      kind: "success",
      supplierTradeNo: tradeNo,
      secret,
      leaveMessage: "这是演示卡密，不对应任何真实商品。",
    };
  }

  async resolveAmbiguous(request: PurchaseRequest): Promise<AmbiguityResolution> {
    const existing = this.#orders.get(request.requestNo);
    if (existing) {
      return {
        kind: "charged_unrecoverable",
        reason: "演示模式：首次请求已落单，按真上游行为无法自动取回",
      };
    }

    const outcome = await this.purchase(request);
    if (outcome.kind === "success") return { kind: "recovered", purchase: outcome };
    if (outcome.kind === "ambiguous") return { kind: "still_ambiguous", reason: outcome.reason };
    return { kind: "not_charged", reason: outcome.reason };
  }

  async queryOrder(
    supplierTradeNo: string,
  ): Promise<{ secret: string; status: number } | null> {
    for (const order of this.#orders.values()) {
      if (order.tradeNo === supplierTradeNo) return { secret: order.secret, status: 1 };
    }
    return null;
  }
}
