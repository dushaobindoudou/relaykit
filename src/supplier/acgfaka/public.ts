/**
 * acg-faka 上游的**公开目录**适配器。
 *
 * 与 client.ts（共享店铺对接协议）的区别，必须说清楚：
 *
 *   client.ts   需要 app_id/app_key，能查价、查库存、**能下单进货**
 *   public.ts   不需要任何凭据，只能读公开目录，**下不了单**
 *
 * 存在的意义是：拿到对接凭据往往要先跟上游站长谈，而在那之前我们就想把
 * 店面铺起来、把 SEO 页面挂出去。这个适配器让目录先跑通，进货那一步
 * 先走人工，等凭据到手再把 driver 换成 acgfaka 即可，店面一行不用改。
 *
 * 数据来源全部是上游前台自己就会返回的公开接口：
 *   /user/api/index/data                 分类树
 *   /user/api/index/commodity            商品列表
 *   /item/{id}                           商品详情（规格与价格内联在页面里）
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

export interface AcgFakaPublicConfig {
  domain: string;
  timeoutMs?: number;
  /**
   * 成本口径。
   *
   * retail = 按上游零售价进货（我们还不是代理时的真实成本）
   * agent  = 按上游代理价进货（**只有真的买了代理才能选**）
   *
   * 默认 retail。选 agent 却没有代理身份，会让定价引擎按一个我们拿不到的
   * 低价算毛利，卖一单亏一单。
   */
  costBasis?: "retail" | "agent";
  /** 单次同步最多拉取多少个商品详情，避免超出 Workers 的子请求配额。 */
  maxDetailFetches?: number;
}

interface ListRow {
  id: number;
  name: string;
  cover?: string;
  price?: number | string;
  stock?: string | number;
  category_id?: number;
  delivery_way?: number;
  tags?: string;
  tags_list?: string[];
  /** 上游显示的累计销量，例如 8485。 */
  order_sold?: number | string;
  /** 缺货时是否接受预订。 */
  reservation_enabled?: number | boolean;
}

/**
 * 从 HTML 里取出 `setVar("_var_item", {...})` 的那个对象。
 *
 * 必须按括号配对扫描而不是用正则：商品详情里嵌了多层对象与包含大括号的
 * 富文本，非贪婪正则会在第一个 `}` 处截断，贪婪正则又会吞掉后面的脚本。
 * 扫描时要跳过字符串字面量内部的括号，否则商品描述里的一个 `}` 就能把
 * 解析带偏。
 */
export function extractInlineJson(html: string, marker: string): unknown | null {
  const at = html.indexOf(marker);
  if (at === -1) return null;

  let i = at + marker.length;
  while (i < html.length && /\s/.test(html[i]!)) i += 1;
  if (html[i] !== "{") return null;

  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < html.length; i += 1) {
    const char = html[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function toDecimal(value: unknown): Decimal | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 上游把布尔序列化为 1/0（JSON 里是 number），也有驱动直接给 boolean。 */
function toFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return undefined;
}

function toCount(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

function parseTags(row: { tags?: string; tags_list?: string[] }): string[] {
  if (Array.isArray(row.tags_list)) return row.tags_list.map(String).filter(Boolean);
  if (typeof row.tags === "string") {
    return row.tags
      .split(/[,，、;；|｜\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

export class AcgFakaPublicAdapter implements SupplierAdapter {
  readonly id: string;

  readonly #domain: string;
  readonly #timeoutMs: number;
  readonly #costBasis: "retail" | "agent";
  readonly #maxDetailFetches: number;

  constructor(config: AcgFakaPublicConfig) {
    this.#domain = config.domain.replace(/\/+$/, "");
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    this.#costBasis = config.costBasis ?? "retail";
    this.#maxDetailFetches = config.maxDetailFetches ?? 25;
    this.id = `acgfaka-public:${new URL(this.#domain).host}`;
  }

  async #get(path: string): Promise<Response> {
    return fetch(`${this.#domain}${path}`, {
      headers: {
        // 带上常规 UA：很多站点会对空 UA 直接返回拦截页。
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "application/json, text/html",
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  async #getJson<T>(path: string): Promise<T> {
    const response = await this.#get(path);
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);

    const payload = (await response.json()) as { code?: number; msg?: string; data?: T };
    if (payload.code !== 200) {
      throw new Error(`${path}: ${payload.msg ?? "上游返回非 200"}`);
    }
    if (payload.data === undefined) throw new Error(`${path}: 无 data`);
    return payload.data;
  }

  async connect(): Promise<{ shopName: string; balance: Decimal }> {
    // 公开目录没有账户概念。用分类接口作为连通性探针，余额恒为 0 ——
    // 余额水位告警在这个模式下没有意义（我们不通过上游账户扣款）。
    const categories = await this.#getJson<unknown[]>("/user/api/index/data");
    return {
      shopName: `${new URL(this.#domain).host}（公开目录，只读）`,
      balance: "0",
    };
  }

  async listCategories(): Promise<SupplierCategory[]> {
    const rows = await this.#getJson<
      { id: number; name: string; icon?: string; pid?: number | null; sort?: number }[]
    >("/user/api/index/data");

    return rows.map((row, index) => ({
      id: String(row.id),
      name: row.name,
      sort: row.sort ?? index,
      ...(row.icon ? { icon: row.icon } : {}),
      ...(row.pid ? { parentId: String(row.pid) } : {}),
    }));
  }

  /**
   * 商品列表。
   *
   * 列表接口只给名称、封面、零售价、库存文案；**规格与成本要逐个拉详情页**。
   * 详情请求数受 maxDetailFetches 限制 —— Workers 单次执行的子请求有配额，
   * 一次拉几十个详情很容易触顶，而且对上游也是不必要的压力。
   * 超出部分会在下一轮同步补上（列表本身已经落库，只是暂时没有规格）。
   */
  async listProducts(): Promise<SupplierProduct[]> {
    const rows = await this.#getJson<ListRow[]>(
      "/user/api/index/commodity?limit=200&page=1",
    );

    const products: SupplierProduct[] = [];
    let detailBudget = this.#maxDetailFetches;

    for (const row of rows) {
      const salesCount = toCount(row.order_sold);
      const reservable = toFlag(row.reservation_enabled);
      const base: SupplierProduct = {
        code: String(row.id),
        name: row.name,
        deliveryWay: Number(row.delivery_way) === 1 ? "manual" : "auto",
        tags: parseTags(row),
        races: [],
        costByRace: {},
        listPriceByRace: {},
        // 上游隐藏具体数字时 stock 是文案（"库存爆棚"）。此时不能判成缺货，
        // 否则整站有货商品会被全部下架。
        stock: typeof row.stock === "number" ? row.stock : 1,
        currencyCode: "CNY",
        ...(row.cover ? { cover: row.cover } : {}),
        ...(row.category_id !== undefined
          ? { categoryId: String(row.category_id) }
          : {}),
        ...(typeof row.stock === "string" ? { stockText: row.stock } : {}),
        ...(salesCount !== undefined ? { salesCount } : {}),
        ...(reservable !== undefined ? { reservable } : {}),
      };

      if (detailBudget > 0) {
        try {
          const detailed = await this.getProduct(base.code);
          products.push(detailed);
          detailBudget -= 1;
          continue;
        } catch {
          // 单个商品详情拉失败不该中断整次同步，退回列表数据。
          // 没有 costByRace 的商品会被定价引擎拒绝上架，是安全的失败方向。
        }
      }

      products.push(base);
    }

    return products;
  }

  async getProduct(code: string): Promise<SupplierProduct> {
    const response = await this.#get(`/item/${encodeURIComponent(code)}`);
    if (!response.ok) throw new Error(`/item/${code} HTTP ${response.status}`);

    const html = await response.text();
    const item = asRecord(extractInlineJson(html, 'setVar("_var_item",'));
    if (Object.keys(item).length === 0) {
      throw new Error(`/item/${code}: 解析不出商品数据`);
    }

    const config = asRecord(item.config);
    const listTable = asRecord(config.category);
    // 成本口径见 AcgFakaPublicConfig.costBasis。
    const costTable =
      this.#costBasis === "agent" ? asRecord(config.category_agent_price) : listTable;

    const races = Object.keys(listTable);
    const listPriceByRace: Record<string, Decimal> = {};
    const costByRace: Record<string, Decimal> = {};

    if (races.length > 0) {
      for (const race of races) {
        const listed = toDecimal(listTable[race]);
        const cost = toDecimal(costTable[race]) ?? listed;
        if (listed) listPriceByRace[race] = listed;
        if (cost) costByRace[race] = cost;
      }
    } else {
      const price = toDecimal(item.price);
      if (price) {
        listPriceByRace[""] = price;
        costByRace[""] = price;
      }
    }

    const stockText = typeof item.stock === "string" ? item.stock : undefined;
    const cover = typeof item.cover === "string" && item.cover ? item.cover : undefined;
    const description =
      typeof item.description === "string" && item.description
        ? item.description
        : undefined;
    const salesCount = toCount(item.order_sold);
    const reservable = toFlag(item.reservation_enabled);
    const isStock = item.is_stock === true || item.is_stock === undefined;

    return {
      code: String(item.id ?? code),
      name: String(item.name ?? ""),
      deliveryWay: Number(item.delivery_way) === 1 ? "manual" : "auto",
      tags: parseTags(item as { tags?: string; tags_list?: string[] }),
      races,
      costByRace,
      listPriceByRace,
      stock: isStock ? Math.max(1, Number(item.stock_raw ?? 1) || 1) : 0,
      currencyCode: "CNY",
      ...(cover ? { cover } : {}),
      ...(item.category_id ? { categoryId: String(item.category_id) } : {}),
      ...(stockText ? { stockText } : {}),
      ...(description ? { description } : {}),
      ...(salesCount !== undefined ? { salesCount } : {}),
      ...(reservable !== undefined ? { reservable } : {}),
    };
  }

  async getStock(code: string, race?: string): Promise<number> {
    const product = await this.getProduct(code);
    void race;
    return product.stock;
  }

  async quote(code: string, quantity: number, race?: string): Promise<Decimal> {
    const product = await this.getProduct(code);
    const unit = product.costByRace[race ?? ""] ?? product.costByRace[""] ?? "0";
    return (Number(unit) * quantity).toFixed(2);
  }

  /**
   * 公开目录下不了单。
   *
   * 明确拒绝而不是抛异常：订单状态机会把它归为「上游明确拒绝」，
   * 于是钱一定没扣、可以安全退款。**绝不能让它落到"结果不确定"那条路径**，
   * 那会把订单推进人工队列并冻结，而这里压根没有发生过任何扣款。
   */
  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    void request;
    return {
      kind: "rejected",
      reason:
        "该上游为公开目录模式，无法自动进货。请向上游申请 app_id / app_key " +
        "并把 driver 改为 acgfaka，或把 fulfillment.mode 设为 manual 走人工发货。",
      insufficientBalance: false,
    };
  }

  async resolveAmbiguous(request: PurchaseRequest): Promise<AmbiguityResolution> {
    void request;
    // 从来没有发起过进货，所以一定没扣款。
    return { kind: "not_charged", reason: "公开目录模式不会发起进货" };
  }

  async queryOrder(): Promise<{ secret: string; status: number } | null> {
    return null;
  }
}
