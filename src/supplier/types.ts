/**
 * 上游供货商适配器 —— 业务侧只依赖这个接口，不依赖任何一家卡网的协议细节。
 *
 * 存在的理由很具体：开站时我们还没拿到 zhanghao66 的 app_id/app_key，也不确定
 * 对方愿不愿意开对接。把协议关在适配器里，换一家上游就是新写一个实现类，
 * 店面 / 收款 / 订单状态机 / 发货一行都不用动。
 */

/** 金额一律用十进制字符串传递，禁止在链路里退化成 number（0.1+0.2 会毁掉对账）。 */
export type Decimal = string;

/** 上游的商品分类。发卡站的商品是挂在分类树下的，丢掉分类就没法还原它的浏览结构。 */
export interface SupplierCategory {
  id: string;
  name: string;
  /** 分类图标 URL，上游通常会给。 */
  icon?: string;
  /** 父分类 id；顶级分类为空。上游支持两级。 */
  parentId?: string;
  sort: number;
}

export interface SupplierProduct {
  /** 上游的对接 CODE，是我们引用商品的唯一键。 */
  code: string;
  name: string;
  /** 商品封面图 URL。 */
  cover?: string;
  /** 所属分类 id，对应 SupplierCategory.id。 */
  categoryId?: string;
  /**
   * 交付方式：auto = 付款后自动发卡密；manual = 需要人工处理。
   * 这个区别必须透传到店面 —— 客户看到"自动发货"和"人工发货"的心理预期完全不同。
   */
  deliveryWay: "auto" | "manual";
  /** 上游给的库存文案（"充足"/"库存爆棚"）。上游隐藏具体数字时只有这个。 */
  stockText?: string;
  /** 商品详情富文本（HTML）。 */
  description?: string;
  /**
   * 上游显示的历史销量（order_sold）。是信任信号，不是我们自己的数据 ——
   * 同步自哪个上游就该在 UI 上如实呈现，绝不与本地订单数混算。
   */
  salesCount?: number;
  /**
   * 缺货时是否接受预订（上游 reservation_enabled）。
   * 原站用它减少缺货流失：客户先付款占位，补货后按付款顺序发货，
   * 等不及的随时可退到余额。
   */
  reservable?: boolean;
  /** 上游打的标签，例如"官方充值"、"畅销"。 */
  tags: string[];
  /** 多规格商品的规格名列表；单规格商品为空数组。上游把它叫 race。 */
  races: string[];
  /**
   * 我们在上游的**实际拿货价**（上游按我们的会员等级现算后返回的 factory_price）。
   * 多规格商品按规格名索引。定价引擎的输入就是它，不要去猜代理价。
   */
  costByRace: Record<string, Decimal>;
  /** 上游标价，仅用于展示"原价"和人工核对，不参与我们的定价计算。 */
  listPriceByRace: Record<string, Decimal>;
  stock: number;
  /** 上游站点的货币代码（valuation 接口会带）。与我们的结算币不一致时必须告警。 */
  currencyCode: string;
}

export interface PurchaseRequest {
  code: string;
  /** 多规格商品必填，单规格留空。 */
  race?: string;
  quantity: number;
  /**
   * 我们生成并持久化的幂等键。重试必须复用同一个值 —— 见 PurchaseOutcome 的说明，
   * 上游用它去重，但去重的表现形式是**报错**而不是回放结果。
   */
  requestNo: string;
  /** 传给上游的联系方式；上游对已登录商户会忽略并改用随机串。 */
  contact?: string;
  /** 商品需要客户填写的自定义字段（账号、邮箱等）。绝大多数卡密商品为空。 */
  widget?: Record<string, string>;
}

export interface PurchaseSuccess {
  kind: "success";
  /** 上游订单号。**唯一**能用于事后 query 对账的凭据，必须落库。 */
  supplierTradeNo: string;
  /** 卡密 / 兑换码正文，直接发给客户。 */
  secret: string;
  /** 上游商品页配置的附言（兑换教程之类），随卡密一并展示。 */
  leaveMessage?: string;
}

/**
 * 下单请求没有得到确定答复（超时、连接中断、非 JSON 响应）。
 *
 * **这是整套系统里唯一可能凭空丢钱的状态**，因为上游可能已经扣了余额、分配了卡，
 * 而我们既没拿到 secret 也没拿到 supplierTradeNo（query 接口只认 supplierTradeNo，
 * 所以此刻我们连查都查不了）。
 *
 * 处理规则，不允许绕过：
 *   1. 绝不自动重试 —— 换个 requestNo 重试 = 二次扣款，复用 requestNo 盲试也拿不到卡。
 *   2. 唯一动作是调 resolveAmbiguous()，它用同一个 requestNo 再打一次，
 *      靠上游的去重报错反推第一次到底有没有落单。
 *   3. 无法判定时一律进人工，不要猜。
 */
export interface PurchaseAmbiguous {
  kind: "ambiguous";
  requestNo: string;
  reason: string;
}

/** 上游明确拒绝（缺货 / 余额不足 / 商品下架 / 未开放对接）。钱一定没扣，可以安全失败。 */
export interface PurchaseRejected {
  kind: "rejected";
  reason: string;
  /** 余额不足要单独识别：它不是这一单的问题，而是整站即将全面停摆的信号。 */
  insufficientBalance: boolean;
}

export type PurchaseOutcome = PurchaseSuccess | PurchaseAmbiguous | PurchaseRejected;

/** resolveAmbiguous 的判定结果。 */
export type AmbiguityResolution =
  /** 确认第一次没落单，钱没扣。可以安全地把客户订单转失败并退款。 */
  | { kind: "not_charged"; reason: string }
  /** 补打成功，第一次确实没落单，这次拿到了卡。正常发货。 */
  | { kind: "recovered"; purchase: PurchaseSuccess }
  /**
   * 确认第一次**已经落单并扣款**，但卡取不回来（上游去重只报错、不回放结果，
   * 且我们没有 supplierTradeNo 可供 query）。只能人工找上游站长捞单。
   * 这条路径必须告警 + 冻结该订单，绝不能静默退款给客户后自己吃掉这笔货。
   */
  | { kind: "charged_unrecoverable"; reason: string }
  /** 仍然判不了（二次请求也超时了）。继续人工，不要再自动打第三次。 */
  | { kind: "still_ambiguous"; reason: string };

export interface SupplierAdapter {
  readonly id: string;

  /** 握手，返回店名与我们在上游的余额。余额水位监控就是轮询它。 */
  connect(): Promise<{ shopName: string; balance: Decimal }>;

  listProducts(): Promise<SupplierProduct[]>;

  /** 拉取分类树。没有分类概念的上游返回空数组，店面会退化成单一列表。 */
  listCategories(): Promise<SupplierCategory[]>;

  /** 单品详情，含现算的 factory_price。商品页应当读它而不是列表缓存。 */
  getProduct(code: string): Promise<SupplierProduct>;

  /** 现拉库存。列表页可以用缓存，下单前必须用这个。 */
  getStock(code: string, race?: string): Promise<number>;

  /** 现拉报价，用于下单前校验我们缓存的成本价没有过期。 */
  quote(code: string, quantity: number, race?: string): Promise<Decimal>;

  purchase(request: PurchaseRequest): Promise<PurchaseOutcome>;

  /** 见 PurchaseAmbiguous。入参必须是原样的 PurchaseRequest，requestNo 不能变。 */
  resolveAmbiguous(request: PurchaseRequest): Promise<AmbiguityResolution>;

  /** 按上游订单号查单，用于日终对账。 */
  queryOrder(
    supplierTradeNo: string,
  ): Promise<{ secret: string; status: number } | null>;
}
