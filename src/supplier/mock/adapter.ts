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
  SupplierCategory,
  SupplierProduct,
} from "@/supplier/types";

export interface MockAdapterOptions {
  /** 演示商品。留空则用内置的一组。 */
  products?: SupplierProduct[];
  categories?: SupplierCategory[];
  initialBalance?: Decimal;
  /**
   * 人为制造的失败率（0~1），用于演示与压测订单状态机的异常分支。
   * 生产配置里不该出现非 0 值。
   */
  failureRate?: number;
  /** 注入随机源，测试里可替换成确定性函数。 */
  random?: () => number;
}

/**
 * 演示数据刻意做成真实发卡站的形状：分类树 + 每类若干商品 + 多规格。
 * 演示环境的结构若比真上游简单，基于它做出来的 UI 接上真站就会散架。
 */
const DEMO_CATEGORIES: SupplierCategory[] = [
  { id: "1", name: "AI 助手", sort: 1 },
  { id: "2", name: "开发工具", sort: 2 },
  { id: "3", name: "设计与创作", sort: 3 },
];

const DEMO_PRODUCTS: SupplierProduct[] = [
  {
    code: "DEMO-ASSISTANT-PRO",
    name: "Demo Assistant Pro",
    categoryId: "1",
    deliveryWay: "auto",
    tags: ["官方充值", "畅销"],
    stockText: "充足",
    salesCount: 8485,
    description:
      "<p>演示商品，不对应任何真实服务。用于展示多规格选择与自动发货流程。</p>",
    races: ["月卡", "季卡", "年卡"],
    costByRace: { 月卡: "30", 季卡: "82", 年卡: "300" },
    listPriceByRace: { 月卡: "48", 季卡: "128", 年卡: "460" },
    stock: 120,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-ASSISTANT-TEAM",
    name: "Demo Assistant Team Seat",
    categoryId: "1",
    deliveryWay: "manual",
    tags: ["人工发货"],
    stockText: "少量",
    races: [],
    costByRace: { "": "180" },
    listPriceByRace: { "": "260" },
    stock: 6,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-CODE-ASSIST",
    name: "Demo Code Assistant",
    categoryId: "2",
    deliveryWay: "auto",
    tags: ["自动发货"],
    stockText: "非常多",
    races: ["个人版", "专业版"],
    costByRace: { 个人版: "45", 专业版: "96" },
    listPriceByRace: { 个人版: "68", 专业版: "148" },
    stock: 88,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-CLOUD-IDE",
    name: "Demo Cloud IDE",
    categoryId: "2",
    deliveryWay: "auto",
    tags: [],
    races: [],
    costByRace: { "": "16" },
    listPriceByRace: { "": "26" },
    stock: 40,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-IMAGE-SUITE",
    name: "Demo Image Suite",
    categoryId: "3",
    deliveryWay: "auto",
    tags: ["畅销"],
    stockText: "充足",
    races: ["标准", "高级"],
    costByRace: { 标准: "22", 高级: "58" },
    listPriceByRace: { 标准: "38", 高级: "88" },
    stock: 64,
    currencyCode: "CNY",
  },
  {
    code: "DEMO-OUT-OF-STOCK",
    name: "Demo Item, backorder available",
    categoryId: "3",
    deliveryWay: "auto",
    tags: [],
    salesCount: 312,
    reservable: true,
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
  readonly #categories: SupplierCategory[];

  constructor(options: MockAdapterOptions = {}) {
    this.#balance = Number(options.initialBalance ?? "5000");
    this.#failureRate = options.failureRate ?? 0;
    this.#random = options.random ?? Math.random;
    this.#products = new Map(
      (options.products ?? DEMO_PRODUCTS).map((item) => [item.code, { ...item }]),
    );
    this.#categories = options.categories ?? DEMO_CATEGORIES;
  }

  async connect(): Promise<{ shopName: string; balance: Decimal }> {
    return { shopName: "代充 Demo Supplier", balance: this.#balance.toFixed(2) };
  }

  async listProducts(): Promise<SupplierProduct[]> {
    return [...this.#products.values()].map((item) => ({ ...item }));
  }

  async listCategories(): Promise<SupplierCategory[]> {
    return this.#categories.map((item) => ({ ...item }));
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
