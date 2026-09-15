/**
 * 代充 配置契约。
 *
 * 这个文件是项目对使用者的全部承诺：一份 YAML 就该能把店开起来，不用改代码。
 * 所以 schema 的取舍原则是 —— **能推断的不要求填，但凡涉及钱的就必须显式写**。
 * 汇率、加价、最低毛利这几项没有"合理默认值"，猜错了就是赔本卖，一律强制填写。
 */

import { z } from "zod";

/** 十进制金额：用字符串传递，绝不落成 number。允许负号是为了让加价支持折扣场景。 */
const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "必须是十进制数字字符串，例如 \"1.5\"（不要用科学计数法）");

/** 非负十进制。 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "必须是非负的十进制数字字符串，例如 \"1.5\"");

const currencyCode = z
  .string()
  .regex(/^[A-Z0-9]{2,10}$/, "货币代码请用大写字母或数字，例如 USDT、CNY");

/**
 * 让一个可选的对象段落也接受 YAML 里的空值。
 *
 * 这不是吹毛求疵：下面这种写法在 YAML 里解析出来是 null 而不是 undefined，
 *
 *     alerts:
 *       # webhookUrl: "..."
 *
 * 而 zod 的 .default() 只对 undefined 生效 —— 于是「把一整段注释掉」这个
 * 再自然不过的操作会直接让配置校验失败，报一句 "Expected object, received null"，
 * 使用者根本不知道自己做错了什么。凡是有默认值的对象段落都要过这一层。
 */
function optionalSection<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema);
}

// ———————————————————————————————— 店铺 ————————————————————————————————

export const storeSchema = z.object({
  name: z.string().min(1),
  /** 面向客户展示与结算的币种。 */
  currency: currencyCode.default("USDT"),
  locale: z.enum(["en", "zh-CN"]).default("en"),
  /** 出现在页脚与订单页；留空则不展示联系入口。 */
  supportUrl: z.string().url().optional(),
  supportEmail: z.string().email().optional(),
  /** 用于生成订单页绝对链接与 SEO canonical。 */
  baseUrl: z.string().url(),
  /** 站点介绍（meta description）。留空则按店名自动生成。 */
  description: z.string().min(1).optional(),
});

// ——————————————————————————————— 上游供货 ———————————————————————————————

export const supplierSchema = z.object({
  /** 本地标识，出现在订单记录与后台，改名会导致历史订单对不上，定了就别改。 */
  id: z.string().regex(/^[a-z0-9-]+$/, "只允许小写字母、数字和连字符"),
  /**
   * 驱动类型。mock 是内置的假上游，用于本地开发与演示 —— 它不碰真钱，
   * 所以可以放心用它跑通全流程再接真站。
   */
  driver: z.enum(["acgfaka", "acgfaka-public", "mock"]),
  domain: z.string().url().optional(),
  appId: z.string().optional(),
  appKey: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
  /** 上游的结算币种。与 store.currency 不同时必须配置 pricing.fx 汇率。 */
  currency: currencyCode.default("CNY"),
  /**
   * 仅 acgfaka-public 驱动：成本口径。
   *
   * retail = 按上游零售价进货（还不是代理时的真实成本）
   * agent  = 按上游代理价进货（**只有真的买了代理才能选**）
   *
   * 选 agent 却没有代理身份，定价引擎会按一个我们拿不到的低价算毛利，
   * 卖一单亏一单。
   */
  costBasis: z.enum(["retail", "agent"]).default("retail"),
  /**
   * WAF 中继（可选）。上游拦 Cloudflare Workers 出口 IP 时，自动采购的
   * 上游请求经由这个中继转发；本地/自有服务器直连时留空。
   */
  relayUrl: z.string().url().optional(),
  /**
   * 自动中转采购（仅 acgfaka-public）：以上游普通客户的身份游客下单，
   * 用热钱包按官方 USDT 通道自动付款，收卡后自动交付。差价留在钱包。
   */
  autoPurchase: z.object({
    enabled: z.boolean(),
    /** 游客下单的联系身份，也是上游订单查询凭据之一。必须是我们可控的邮箱。 */
    contact: z.string().email(),
    /** 上游支付通道 id（/user/api/index/pay 列表）。必须是 EVM USDT 通道才能自动付款。 */
    payChannelId: z.number().int().min(1),
    /** 资金护栏：单笔自动付款的 USDT 上限，超出转人工。默认 "30"。 */
    maxPayUsdt: decimalString.default("30"),
    /** 上游通道最低金额门槛，低于时自动凑单（多买的余量进本地库存）。默认 "25"。 */
    minBatchCny: decimalString.default("25"),
  }).optional(),
}).superRefine((value, ctx) => {
  // acgfaka-public 只需要 domain。
  if (value.driver === "acgfaka-public" && !value.domain) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["domain"],
      message: "driver 为 acgfaka-public 时必须配置 domain",
    });
    return;
  }
  // acgfaka 驱动必须有三件套，缺一个都连不上。在 schema 层拦住，
  // 好过等到第一笔真实订单才报"商户ID不存在"。
  if (value.driver !== "acgfaka") return;
  for (const field of ["domain", "appId", "appKey"] as const) {
    if (!value[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `driver 为 acgfaka 时必须配置 ${field}`,
      });
    }
  }
});

// ———————————————————————————————— 定价 ————————————————————————————————

export const markupSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fixed"),
    /** 以 store.currency 计的固定加价，例如 "1.0" 表示每单赚 1 USDT。 */
    amount: decimalString,
  }),
  z.object({
    type: z.literal("percent"),
    /** 百分比加价，"15" 表示在成本上加 15%。 */
    amount: decimalString,
  }),
]);

export const fxSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("static"),
    /**
     * 形如 { "CNY_USDT": "0.1389" }，含义是「1 CNY = 0.1389 USDT」。
     * 静态汇率适合起步阶段，但**它不会自己更新** —— 配合 maxStalenessHours
     * 用，过期就停止上架而不是继续按老汇率卖。
     */
    rates: z.record(
      z.string().regex(/^[A-Z0-9]+_[A-Z0-9]+$/, "汇率键格式为 FROM_TO，例如 CNY_USDT"),
      positiveDecimalString,
    ),
    /** 配置写入时间，用于判断静态汇率是否已经陈旧。 */
    updatedAt: z.string().datetime().optional(),
  }),
  z.object({
    source: z.literal("coingecko"),
    /** 免费接口有速率限制，拉取间隔别设太小。 */
    refreshMinutes: z.number().int().min(5).default(30),
  }),
]);

export const pricingSchema = z.object({
  fx: fxSchema,
  /** 默认加价规则。 */
  markup: markupSchema,
  /**
   * 最低毛利护栏。汇率跳动或上游涨价都可能让售价跌到成本线下，
   * 低于这个百分比的商品会被**自动下架**而不是继续卖。
   * 设成 0 等于关闭保护 —— 除非你清楚自己在做什么，否则别这么干。
   */
  minMarginPercent: z.number().min(0).max(100).default(3),
  /**
   * 汇率允许的最大漂移。超过时停止自动改价并告警，避免行情剧烈波动时
   * 按错误汇率成交。
   */
  maxDriftPercent: z.number().min(0).max(100).default(10),
  /** 汇率超过这个时长未更新就视为不可信，停止上架。 */
  maxStalenessHours: z.number().min(0).default(24),
  rounding: optionalSection(
    z
      .object({
        /** up = 永远向上取整到 increment（保护毛利）；nearest = 四舍五入。 */
        mode: z.enum(["up", "nearest"]).default("up"),
        increment: positiveDecimalString.default("0.01"),
      })
      .default({ mode: "up", increment: "0.01" }),
  ),
  /** 针对单个商品覆盖默认加价。 */
  overrides: optionalSection(
    z
    .array(
      z.object({
        supplier: z.string(),
        /** 上游商品的对接 CODE。 */
        code: z.string(),
        /** 留空表示该商品的所有规格。 */
        race: z.string().optional(),
        markup: markupSchema,
      }),
    )
    .default([]),
  ),
});

// ———————————————————————————————— 收款 ————————————————————————————————

export const chainSchema = z.object({
  id: z.enum(["polygon", "bsc", "tron", "ethereum"]),
  enabled: z.boolean().default(true),
  /**
   * 收款地址。**这是钱的去处，配错等于把收入送给别人**，部署前务必核对。
   *
   * 允许填 UNSET：示例配置用它作为缺省值，好让人先把站点跑起来看看。
   * 见 isPlaceholderAddress —— 健康检查会标红，下单接口会拒绝建单，
   * 所以这个占位值不可能悄悄进入生产。
   */
  address: z.string().min(1),
  /**
   * 入账所需确认数。给低了会有重组风险，给高了客户等得久。
   * 默认值按各链的常见安全线给，金额大的场景应当调高。
   */
  confirmations: z.number().int().min(1).default(12),
  /** 自定义 RPC；留空则用内置的公共节点（有速率限制，生产环境建议自备）。 */
  rpcUrl: z.string().url().optional(),
  /** 该链上的 USDT 合约地址；留空用内置的官方合约。 */
  tokenAddress: z.string().optional(),
});

export const paymentsSchema = z.object({
  /** 付款窗口，超时未支付自动关单并释放库存占用。 */
  windowMinutes: z.number().int().min(5).max(720).default(30),
  chains: z.array(chainSchema).min(1, "至少要启用一条收款链"),
  /**
   * 手动收款渠道（支付宝/微信转账）：客户转账、管理员人工确认到账，
   * 确认后照走自动采购管线发货。人工对账有成本，这类订单按
   * markupPercent（成本口径）重新计价 —— 通常比链上自动收款贵。
   */
  manual: optionalSection(
    z
      .object({
        enabled: z.boolean().default(false),
        /** 手动渠道订单的加价（成本口径百分比）。链上是 20% 时这里通常是 "30"。 */
        markupPercent: decimalString.default("30"),
        /** 未付款的人工收款单保留时长（小时），超时自动关闭。 */
        windowHours: z.number().int().min(1).max(168).default(24),
        channels: z
          .array(
            z.object({
              /** 渠道标识，出现在订单 pay_method 与结账表单里（如 alipay/wechat）。 */
              id: z.string().regex(/^[a-z0-9-]+$/, "只允许小写字母、数字和连字符"),
              label: z.string().min(1),
              /** 收款账号（手机号/邮箱/微信号），展示给客户。 */
              account: z.string().min(1),
              /** 收款码图片地址（可选，/media/ 下的本地图）。 */
              qrImage: z.string().optional(),
              /** 转账说明（如"转账请备注订单号"）。 */
              instructions: z.string().optional(),
            }),
          )
          .default([]),
      })
      .default({ enabled: false, markupPercent: "30", windowHours: 24, channels: [] }),
  ),
  /**
   * 金额打标：同一个收款地址靠唯一的小数尾数区分订单，省掉为每单派生地址
   * 的密钥管理。
   *
   * 尾数只占用**价格精度（两位小数）之后**的位，所以可用槽位是
   * 10^(decimals − 2)，而多收的金额永远小于一分钱。
   * 默认 6：一万个槽位，够绝大多数店用；USDT 在主流链上也正好是 6 位精度。
   * 给小了会在高峰期分配不出唯一金额。
   */
  amountTagging: optionalSection(
    z
      .object({
        enabled: z.boolean().default(true),
        decimals: z.number().int().min(3).max(6).default(6),
      })
      .default({ enabled: true, decimals: 6 }),
  ),
});

// ——————————————————————————————— 履约与告警 ———————————————————————————————

export const fulfillmentSchema = z.object({
  /** auto = 收款确认后自动向上游下单；manual = 只记账，人工发货。 */
  mode: z.enum(["auto", "manual"]).default("auto"),
  /**
   * 上游余额低于此值时告警。余额耗尽会让**整站停摆且客户已付款**，
   * 阈值至少留够三天流水。
   */
  balanceAlertThreshold: positiveDecimalString.default("100"),
  /** 上游余额不足时是否自动把商品下架，避免继续收钱却发不出货。 */
  haltSalesOnLowBalance: z.boolean().default(true),
});

export const alertsSchema = optionalSection(
  z.object({
    /** 收到 JSON POST 的通用 webhook，可对接飞书/Slack/TG Bot。 */
    webhookUrl: z.string().url().optional(),
    telegram: optionalSection(
      z.object({ botToken: z.string(), chatId: z.string() }).optional(),
    ),
  }).default({}),
);

// ———————————————————————————————— 总配置 ————————————————————————————————

export const configSchema = z.object({
  store: storeSchema,
  suppliers: z.array(supplierSchema).min(1, "至少要配置一个上游供货商"),
  pricing: pricingSchema,
  payments: paymentsSchema,
  fulfillment: optionalSection(fulfillmentSchema.default({})),
  alerts: alertsSchema,
});

export type DaichongConfig = z.infer<typeof configSchema>;
export type SupplierConfig = z.infer<typeof supplierSchema>;
export type MarkupConfig = z.infer<typeof markupSchema>;
export type PricingConfig = z.infer<typeof pricingSchema>;
export type ChainConfig = z.infer<typeof chainSchema>;
export type PaymentsConfig = z.infer<typeof paymentsSchema>;

/**
 * 该地址是否只是占位符。
 *
 * 单独抽成函数而不是散在各处比较字符串：收款地址是整个系统里错一次
 * 就直接损失收入的字段，判定逻辑必须只有一处。
 */
export function isPlaceholderAddress(address: string): boolean {
  const normalized = address.trim().toUpperCase();
  return (
    normalized === "" ||
    normalized === "UNSET" ||
    normalized === "REPLACE_ME" ||
    /^0X0{40}$/.test(normalized)
  );
}

/** 已配置好、可以真正收款的链。 */
export function payableChains(config: DaichongConfig): ChainConfig[] {
  return config.payments.chains.filter(
    (chain) => chain.enabled && !isPlaceholderAddress(chain.address),
  );
}
