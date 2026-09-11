/**
 * acg-faka「共享店铺 / 商品对接」协议的适配器实现。
 *
 * 协议摘自上游源码 app/Controller/Shared/*.php 与 app/Service/Bind/Shared.php：
 * 全部是 POST application/x-www-form-urlencoded，鉴权字段 app_id + sign，
 * 响应恒为 {code, msg, data}，code === 200 才算成功（HTTP 状态码一律 200，
 * 不能用它判断成败）。
 */

import { signedForm, type SignPayload } from "./signature";
import type {
  AmbiguityResolution,
  Decimal,
  PurchaseOutcome,
  PurchaseRequest,
  SupplierAdapter,
  SupplierCategory,
  SupplierProduct,
} from "@/supplier/types";

export interface AcgFakaConfig {
  /** 上游站点根地址，不带尾部斜杠，例如 https://zhanghao66.com */
  domain: string;
  appId: string;
  appKey: string;
  /** 单次请求超时。默认 20s —— 上游 trade 是同步扣款+发卡，偶尔会慢。 */
  timeoutMs?: number;
}

/** 上游业务错误（code !== 200）。到这一步可以确定请求被完整处理过。 */
export class AcgFakaError extends Error {
  // 不用构造函数参数属性：Node 的 --experimental-strip-types 只做类型剥离，
  // 不支持那个语法（它需要真正的代码生成）。
  readonly code: number;
  readonly upstreamMessage: string;

  constructor(code: number, upstreamMessage: string) {
    super(`上游拒绝 (code=${code}): ${upstreamMessage}`);
    this.name = "AcgFakaError";
    this.code = code;
    this.upstreamMessage = upstreamMessage;
  }
}

/** 传输层失败：超时、连接中断、响应不是 JSON。请求是否被处理**未知**。 */
export class AcgFakaTransportError extends Error {
  constructor(reason: string) {
    super(`上游无确定答复: ${reason}`);
    this.name = "AcgFakaTransportError";
  }
}

/**
 * 上游对重复 request_no 的响应。注意它是**报错**而不是回放原订单结果
 * （见 Service/Bind/Order.php：`throw new JSONException("The request ID already exists")`），
 * 这正是我们用来反推"第一次到底落没落单"的判据。
 *
 * 文案会过上游的 lang() 翻译，且各版本可能微调，所以按多组特征匹配而不是全等。
 * 匹配不上时一律落到"判不了"，绝不乐观假设没扣款。
 */
const DUPLICATE_REQUEST_PATTERNS = [
  /request id already exists/i,
  /请求.{0,4}(ID|编号).{0,4}已存在/,
  /重复.{0,4}(请求|提交)/,
];

function isDuplicateRequestError(message: string): boolean {
  return DUPLICATE_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

/** 余额不足要单独识别：这不是单笔问题，是整站即将停摆。 */
const INSUFFICIENT_BALANCE_PATTERNS = [/余额不足/, /insufficient balance/i];

function isInsufficientBalance(message: string): boolean {
  return INSUFFICIENT_BALANCE_PATTERNS.some((pattern) => pattern.test(message));
}

interface UpstreamEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** 上游的金额字段有时是 number 有时是字符串，统一收敛成十进制字符串。 */
function toDecimal(value: unknown, fallback: Decimal = "0"): Decimal {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

/** 上游的 tags 有时是数组有时是逗号分隔的串，统一成数组。 */
function toTags(row: Record<string, unknown>): string[] {
  const list = row.tags_list;
  if (Array.isArray(list)) return list.map(String).filter(Boolean);
  if (typeof row.tags === "string") {
    return row.tags
      .split(/[,，、;；|｜\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export class AcgFakaAdapter implements SupplierAdapter {
  readonly id: string;

  readonly #domain: string;
  readonly #appId: string;
  readonly #appKey: string;
  readonly #timeoutMs: number;

  constructor(config: AcgFakaConfig) {
    this.#domain = config.domain.replace(/\/+$/, "");
    this.#appId = config.appId;
    this.#appKey = config.appKey;
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    this.id = `acgfaka:${new URL(this.#domain).host}`;
  }

  /**
   * 发一次已签名的 POST。
   *
   * 两类失败严格分开，因为它们的资金含义完全不同：
   *   - AcgFakaError        上游明确回了业务错误 → 请求被处理过，没扣款
   *   - AcgFakaTransportError 没拿到确定答复     → 可能已扣款
   * 任何"统一 catch 成一种错误"的写法都会把第二类伪装成第一类，进而触发
   * 危险的自动重试。不要合并。
   */
  async #post(path: string, payload: SignPayload): Promise<unknown> {
    const body = signedForm({ ...payload, app_id: this.#appId }, this.#appKey);

    let response: Response;
    try {
      response = await fetch(`${this.#domain}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new AcgFakaTransportError(
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text().catch(() => "");

    let envelope: UpstreamEnvelope;
    try {
      envelope = JSON.parse(text) as UpstreamEnvelope;
    } catch {
      // 非 JSON 通常是 WAF 拦截页或 502。请求可能已经到达业务层，算不确定。
      throw new AcgFakaTransportError(
        `HTTP ${response.status}，响应不是 JSON: ${text.slice(0, 200)}`,
      );
    }

    const code = Number(envelope.code);
    const message = typeof envelope.msg === "string" ? envelope.msg : "";

    if (code !== 200) {
      throw new AcgFakaError(Number.isFinite(code) ? code : -1, message);
    }

    return envelope.data;
  }

  async connect(): Promise<{ shopName: string; balance: Decimal }> {
    const data = asRecord(await this.#post("/shared/authentication/connect", {}));
    return {
      shopName: typeof data.shopName === "string" ? data.shopName : "",
      balance: toDecimal(data.balance),
    };
  }

  /**
   * 把上游的商品行收敛成 SupplierProduct。
   *
   * 多规格商品的价格不在顶层，而在 config 里：category 是标价表、
   * category_factory 是上游按**我们的身份**现算的拿货价（item 接口才有，
   * items 列表接口不带）。单规格商品则用顶层 price / factory_price。
   */
  #toProduct(
    row: Record<string, unknown>,
    currencyCode: string,
    categoryId?: string,
  ): SupplierProduct {
    const config = asRecord(row.config);
    const listTable = asRecord(config.category);
    const costTable = asRecord(config.category_factory);
    const races = Object.keys(listTable);

    const listPriceByRace: Record<string, Decimal> = {};
    const costByRace: Record<string, Decimal> = {};

    if (races.length > 0) {
      for (const race of races) {
        listPriceByRace[race] = toDecimal(listTable[race]);
        // 缺 category_factory 时留空而不是填 0：0 会被定价引擎当成"白拿的货"，
        // 算出低于成本的售价。宁可让上层因为缺价而拒绝上架。
        const cost = costTable[race];
        if (cost !== undefined) costByRace[race] = toDecimal(cost);
      }
    } else {
      listPriceByRace[""] = toDecimal(row.price);
      const factory = row.factory_price;
      if (factory !== undefined) costByRace[""] = toDecimal(factory);
    }

    // 上游的 delivery_way：0 = 自动发卡密，1 = 人工发货。
    const deliveryWay = toCount(row.delivery_way) === 1 ? "manual" : "auto";

    // categoryId 优先用调用方从分类树上下文传进来的；items 的商品行里
    // 也带 category_id，但 item 详情接口的口径不一定一致，以树为准。
    const resolvedCategory =
      categoryId ??
      (row.category_id !== undefined && row.category_id !== null
        ? String(row.category_id)
        : undefined);

    const cover = typeof row.cover === "string" && row.cover !== "" ? row.cover : undefined;
    const stockText =
      typeof row.stock === "string" && row.stock !== "" ? row.stock : undefined;
    const description =
      typeof row.description === "string" && row.description !== ""
        ? row.description
        : undefined;
    // 销量与预订开关：对接协议是否返回以实际响应为准，缺了就是 undefined，
    // 只影响店面展示，不影响定价。
    const salesCountRaw = Number(row.order_sold);
    const salesCount =
      Number.isFinite(salesCountRaw) && salesCountRaw >= 0
        ? Math.floor(salesCountRaw)
        : undefined;
    const reservableFlag = row.reservation_enabled;
    const reservable =
      reservableFlag === 1 || reservableFlag === true || reservableFlag === "1"
        ? true
        : undefined;

    return {
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      deliveryWay,
      tags: toTags(row),
      races,
      costByRace,
      listPriceByRace,
      // 上游隐藏库存数字时 stock 是文案（"充足"），toCount 会得到 0。
      // 此时不能判成缺货 —— 那会把整站有货商品全部下架。给一个保守的正数，
      // 真正的库存判定在下单前的 getStock 与进货那一步。
      stock: stockText ? Math.max(1, toCount(row.stock)) : toCount(row.stock),
      currencyCode,
      ...(cover ? { cover } : {}),
      ...(resolvedCategory ? { categoryId: resolvedCategory } : {}),
      ...(stockText ? { stockText } : {}),
      ...(description ? { description } : {}),
      ...(salesCount !== undefined ? { salesCount } : {}),
      ...(reservable ? { reservable } : {}),
    };
  }

  async listProducts(): Promise<SupplierProduct[]> {
    const tree = await this.#post("/shared/commodity/items", {});
    const products: SupplierProduct[] = [];

    // items 返回的是 [{...分类, children: [...商品]}]，且商品价格是列表快照。
    // 注意上游源码注释明说 stock 是"尽力而为"的缓存读数，可能陈旧 —— 下单前
    // 必须用 getStock() 现拉，不能信这里的数字。
    for (const node of Array.isArray(tree) ? tree : []) {
      const category = asRecord(node);
      const categoryId = category.id !== undefined ? String(category.id) : undefined;
      const children = category.children;
      for (const child of Array.isArray(children) ? children : []) {
        products.push(this.#toProduct(asRecord(child), "UNKNOWN", categoryId));
      }
    }

    return products;
  }

  /**
   * 分类树。
   *
   * 与 listProducts 打的是同一个接口 —— 上游把分类和商品揉在一次响应里，
   * 分开拉会多打一次跨站请求。调用方通常紧挨着调这两个，代价可接受；
   * 若将来成为瓶颈，应当改成一次拉取返回 {categories, products}。
   */
  async listCategories(): Promise<SupplierCategory[]> {
    const tree = await this.#post("/shared/commodity/items", {});
    const categories: SupplierCategory[] = [];

    for (const [index, node] of (Array.isArray(tree) ? tree : []).entries()) {
      const row = asRecord(node);
      if (row.id === undefined || row.id === null) continue;

      const icon = typeof row.icon === "string" && row.icon !== "" ? row.icon : undefined;
      const parentId =
        row.pid !== undefined && row.pid !== null && String(row.pid) !== ""
          ? String(row.pid)
          : undefined;

      categories.push({
        id: String(row.id),
        name: String(row.name ?? ""),
        sort: toCount(row.sort ?? index),
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
    }

    return categories;
  }

  async getProduct(code: string): Promise<SupplierProduct> {
    const [row, currencyCode] = await Promise.all([
      this.#post("/shared/commodity/item", { code }).then(asRecord),
      this.#currencyCode(code),
    ]);
    return this.#toProduct(row, currencyCode);
  }

  /** 货币代码只有 valuation 接口会带，单独取一次。 */
  async #currencyCode(code: string): Promise<string> {
    try {
      const data = asRecord(
        await this.#post("/shared/commodity/valuation", { code, num: 1 }),
      );
      return typeof data.currency_code === "string" ? data.currency_code : "UNKNOWN";
    } catch {
      // 老版本上游没有这个字段，不足以让整个商品同步失败。
      return "UNKNOWN";
    }
  }

  async getStock(code: string, race?: string): Promise<number> {
    const data = asRecord(
      await this.#post("/shared/commodity/stock", { code, race: race ?? "" }),
    );
    return toCount(data.stock);
  }

  async quote(code: string, quantity: number, race?: string): Promise<Decimal> {
    const data = asRecord(
      await this.#post("/shared/commodity/valuation", {
        code,
        num: quantity,
        race: race ?? "",
      }),
    );
    return toDecimal(data.price);
  }

  /** trade 的请求体。resolveAmbiguous 必须复用它，两次必须逐字节一致。 */
  #tradePayload(request: PurchaseRequest): SignPayload {
    const payload: SignPayload = {
      shared_code: request.code,
      num: request.quantity,
      race: request.race ?? "",
      request_no: request.requestNo,
      contact: request.contact ?? "",
      card_id: 0,
      device: 0,
      password: "",
    };

    // widget 字段在上游是平铺到顶层的（见 Bind/Shared::trade 里的 foreach），
    // 不是嵌套对象。平铺时要避开协议保留字，否则会串改下单参数。
    for (const [key, value] of Object.entries(request.widget ?? {})) {
      if (key in payload || key === "app_id" || key === "sign") continue;
      payload[key] = value;
    }

    return payload;
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    try {
      const data = asRecord(
        await this.#post("/shared/commodity/trade", this.#tradePayload(request)),
      );

      const supplierTradeNo = String(data.tradeNo ?? "");
      const secret = typeof data.secret === "string" ? data.secret : "";

      // 拿到 200 但没有 tradeNo，就等于拿到了一张无法对账的订单。当作不确定处理，
      // 让它走人工，不要发一张来路不明的卡给客户。
      if (supplierTradeNo === "") {
        return {
          kind: "ambiguous",
          requestNo: request.requestNo,
          reason: "上游返回成功但缺少 tradeNo，无法对账",
        };
      }

      const leaveMessage =
        typeof data.leave_message === "string" && data.leave_message !== ""
          ? data.leave_message
          : undefined;

      return {
        kind: "success",
        supplierTradeNo,
        secret,
        ...(leaveMessage === undefined ? {} : { leaveMessage }),
      };
    } catch (error) {
      if (error instanceof AcgFakaError) {
        return {
          kind: "rejected",
          reason: error.upstreamMessage,
          insufficientBalance: isInsufficientBalance(error.upstreamMessage),
        };
      }

      if (error instanceof AcgFakaTransportError) {
        return {
          kind: "ambiguous",
          requestNo: request.requestNo,
          reason: error.message,
        };
      }

      throw error;
    }
  }

  /**
   * 用同一个 request_no 再打一次 trade，靠上游的去重行为反推第一次的结局。
   *
   * 上游的去重是"已存在就抛错"而不是"回放原结果"，所以这次请求有三种结局：
   *   报重复错  → 第一次确实落单了，钱扣了，但卡取不回来（我们没有 tradeNo，
   *               query 接口按 tradeNo 查，查不了）→ 只能人工找上游捞单
   *   报其他错  → 上游没有这条 request_no 的订单，第一次没落单 → 钱没扣，安全失败
   *   成功      → 第一次确实没落单，这次补上了 → 正常发货
   *
   * 只打这一次。再超时就交给人工，绝不打第三次。
   */
  async resolveAmbiguous(request: PurchaseRequest): Promise<AmbiguityResolution> {
    let outcome: PurchaseOutcome;
    try {
      outcome = await this.purchase(request);
    } catch (error) {
      return {
        kind: "still_ambiguous",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.kind === "success") {
      return { kind: "recovered", purchase: outcome };
    }

    if (outcome.kind === "ambiguous") {
      return { kind: "still_ambiguous", reason: outcome.reason };
    }

    if (isDuplicateRequestError(outcome.reason)) {
      return {
        kind: "charged_unrecoverable",
        reason:
          `上游已存在 request_no=${request.requestNo} 的订单，说明首次请求已扣款成功，` +
          `但协议不回放原结果且我们没有 tradeNo，无法自动取回卡密。需人工联系上游站长捞单。`,
      };
    }

    return { kind: "not_charged", reason: outcome.reason };
  }

  async queryOrder(
    supplierTradeNo: string,
  ): Promise<{ secret: string; status: number } | null> {
    try {
      const data = asRecord(
        await this.#post(
          `/shared/commodity/query/${encodeURIComponent(supplierTradeNo)}`,
          {},
        ),
      );
      return {
        secret: typeof data.secret === "string" ? data.secret : "",
        status: toCount(data.status),
      };
    } catch (error) {
      // "订单不存在"是正常的否定答复，不是故障。
      if (error instanceof AcgFakaError) return null;
      throw error;
    }
  }
}
