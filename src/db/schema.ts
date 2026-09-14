/**
 * D1 (SQLite) 表结构。
 *
 * 两条贯穿始终的原则：
 *
 * 1. **金额一律存 TEXT**。SQLite 的 REAL 是 IEEE754 浮点，存 0.1 再读出来
 *    就不是 0.1 了；几千单累计下来对账必然对不平。所有金额字段都是十进制
 *    字符串，运算在 Decimal 里做。
 *
 * 2. **定价是快照，不是引用**。订单落库时把当时的售价、成本、汇率一并写死。
 *    上游次日涨价或汇率跳动都不该改变一张已成交订单的账 —— 事后重算出来的
 *    数字既对不上客户付的款，也对不上我们付给上游的钱。
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 时间统一存 ISO 8601 字符串：可读、可排序、不受时区解释影响。 */
const timestamp = (name: string) => text(name);

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),

    /** 见 src/orders/state.ts 的 OrderStatus。 */
    status: text("status").notNull().default("draft"),

    // —— 商品 ——
    supplierId: text("supplier_id").notNull(),
    productCode: text("product_code").notNull(),
    /** 规格名。单规格商品存空串，不存 NULL —— 免得每处查询都要处理三态。 */
    race: text("race").notNull().default(""),
    productName: text("product_name").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),

    // —— 定价快照（下单瞬间写死，永不回填）——
    /** 客户应付总额，以 currency 计。 */
    priceTotal: text("price_total").notNull(),
    /** 当时换算到 currency 的进货成本，用于毛利报表与对账。 */
    costSnapshot: text("cost_snapshot").notNull(),
    /** 当时用的汇率，留档以便复现历史定价。 */
    fxRate: text("fx_rate").notNull().default("1"),
    currency: text("currency").notNull(),

    // —— 幂等 ——
    /**
     * 我们生成并持久化的上游幂等键。**必须在发起进货之前就写库**，
     * 否则进程在发请求与落库之间崩溃，重启后会用新的 requestNo 再下一单，
     * 变成重复扣款。
     */
    requestNo: text("request_no").notNull(),

    // —— 收款 ——
    chainId: text("chain_id"),
    payAddress: text("pay_address"),
    /**
     * 打标后的唯一金额。同一条链上所有**未关闭**订单的该值必须互不相同，
     * 否则一笔到账无法归属到唯一订单。见下方 payAmountOpenUnique。
     */
    payAmount: text("pay_amount"),
    payWindowEndsAt: timestamp("pay_window_ends_at"),
    paidTxHash: text("paid_tx_hash"),
    paidAmount: text("paid_amount"),
    paidAt: timestamp("paid_at"),

    // —— 履约 ——
    supplierTradeNo: text("supplier_trade_no"),
    /** 卡密正文。只有 status=fulfilled 时才允许下发给客户。 */
    secret: text("secret"),
    leaveMessage: text("leave_message"),
    /** 进入人工队列的原因，直接展示在后台待办里。 */
    reviewReason: text("review_reason"),
    /**
     * 预订单：创建时库存不足但商品可预订。付款后进入 reserved 排队，
     * 补货后走正常进货；客户可随时退到余额。见 orders/state.ts。
     */
    reservation: integer("reservation", { mode: "boolean" }).notNull().default(false),

    // —— 自动中转采购（上游游客订单侧）——
    /** 上游订单号。null = 尚未向上游下单（或该供应商不走自动采购）。 */
    upstreamTradeNo: text("upstream_trade_no"),
    /** 上游 USDT 收银台的精确应付金额（原样字符串，绝不再换算）。 */
    upstreamPayAmount: text("upstream_pay_amount"),
    /** 上游收款地址与链（收银台解析结果）。 */
    upstreamPayAddress: text("upstream_pay_address"),
    upstreamPayChain: text("upstream_pay_chain"),
    /** 我们热钱包的出款交易哈希。非空 = 已付，等上游确认发货。 */
    upstreamPaidTxHash: text("upstream_paid_tx_hash"),
    /** 游客下单用的联系邮箱（查询凭据之一）。 */
    upstreamContact: text("upstream_contact"),
    /** 上游下单尝试次数（过期重下限制在 3 次内）。 */
    upstreamAttempt: integer("upstream_attempt").notNull().default(0),

    // —— 优惠 ——
    couponCode: text("coupon_code"),
    /** 优惠减免额，以 currency 计。priceTotal 是**减免后**的应付额。 */
    discount: text("discount").notNull().default("0"),

    // —— 客户 ——
    /** 登录用户下单时记录；匿名下单为 null。 */
    userId: text("user_id"),
    /** balance = 余额支付；其余为链上支付。 */
    payMethod: text("pay_method").notNull().default("chain"),
    contactEmail: text("contact_email"),
    /** 订单查询口令的哈希，绝不存明文。 */
    queryPasswordHash: text("query_password_hash"),

    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    // 上游幂等键全局唯一：这是"绝不重复进货"的最后一道数据库级防线。
    // 应用层的状态机会先拦一次，但并发实例之间只有唯一索引拦得住。
    uniqueIndex("orders_request_no_unique").on(table.requestNo),

    // 金额打标的核心约束：同一条链上，待付款订单的金额必须唯一。
    // 用部分索引而不是全表唯一 —— 已关闭的订单不再参与归属判定，
    // 它们占着的金额应当可以被后续订单复用，否则尾数空间很快耗尽。
    uniqueIndex("orders_pay_amount_open_unique")
      .on(table.chainId, table.payAmount)
      .where(sql`status = 'awaiting_payment'`),

    index("orders_status_idx").on(table.status),
    index("orders_created_at_idx").on(table.createdAt),
    // 收款监听按 (链, 金额) 反查待付订单，这条索引直接决定轮询的开销。
    index("orders_chain_amount_idx").on(table.chainId, table.payAmount),
    // 「我的订单」按用户倒序列出。
    index("orders_user_idx").on(table.userId, table.createdAt),
    // 按邮箱查单（原站的订单查询方式）。
    index("orders_contact_idx").on(table.contactEmail),
  ],
);

/**
 * 状态迁移审计日志。
 *
 * 每一次迁移（含被拒绝的）都落一条。出问题时，"这笔钱到底经历了什么"
 * 必须能从库里读出来，而不是靠翻日志 —— 日志会滚掉，钱的事不能靠运气。
 */
export const orderEvents = sqliteTable(
  "order_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id").notNull(),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status").notNull(),
    /** 迁移被拒时为 null。 */
    toStatus: text("to_status"),
    accepted: integer("accepted", { mode: "boolean" }).notNull(),
    /** 拒绝理由，或本次迁移的补充信息（JSON）。 */
    detail: text("detail"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("order_events_order_idx").on(table.orderId, table.createdAt)],
);

/**
 * 已处理过的链上转账。
 *
 * 收款监听会重复看到同一笔转账（重扫、重启、节点回放），靠这张表去重。
 * 主键是 (链, txHash, logIndex) —— 只用 txHash 不够：一笔交易里可能有
 * 多次 Transfer（批量转账合约），各自是独立的入账。
 */
export const seenTransfers = sqliteTable(
  "seen_transfers",
  {
    chainId: text("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    /** 归属到的订单；认不出来时为 null，留给人工排查。 */
    orderId: text("order_id"),
    toAddress: text("to_address").notNull(),
    amount: text("amount").notNull(),
    blockNumber: integer("block_number").notNull(),
    seenAt: timestamp("seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("seen_transfers_pk").on(
      table.chainId,
      table.txHash,
      table.logIndex,
    ),
    index("seen_transfers_unmatched_idx").on(table.orderId),
  ],
);

/**
 * 收款监听的扫描游标：每条链扫到哪个区块了。
 *
 * 独立成表而不是放内存，因为 Workers 没有常驻进程 —— 每次 Cron 触发
 * 都是全新的实例，游标必须持久化。
 */
export const chainCursors = sqliteTable("chain_cursors", {
  chainId: text("chain_id").primaryKey(),
  lastScannedBlock: integer("last_scanned_block").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * 商品目录快照。
 *
 * 上游的 items 接口按其源码注释是"尽力而为"的缓存读数，且每次拉取都要
 * 打一次上游 HTTP。店面列表页读这张表，只有商品详情页与下单前才现拉。
 */
export const products = sqliteTable(
  "products",
  {
    supplierId: text("supplier_id").notNull(),
    code: text("code").notNull(),
    race: text("race").notNull().default(""),
    name: text("name").notNull(),
    /** 上游成本（上游结算币）。 */
    cost: text("cost").notNull(),
    /** 算好的售价（店铺展示币）。不可售时为 null。 */
    price: text("price"),
    /** 所属分类的 externalId。上游没有分类概念时为 null。 */
    categoryId: text("category_id"),
    cover: text("cover"),
    /** auto = 自动发卡密；manual = 人工发货。客户对这两者的预期完全不同。 */
    deliveryWay: text("delivery_way").notNull().default("auto"),
    /** 上游给的库存文案（"充足"）。上游隐藏数字时只有这个。 */
    stockText: text("stock_text"),
    /** 商品详情富文本。 */
    description: text("description"),
    /**
     * 上游显示的历史销量（order_sold）。是**上游的**累计销量，不是本店
     * 订单数 —— 展示时如实标注，绝不与本地数据混算。为 null 时 UI 不显示。
     */
    salesCount: integer("sales_count"),
    /** 上游标签，逗号分隔。 */
    tags: text("tags"),
    /**
     * 批发阶梯价，JSON：[{minQty, price}]，按 minQty 升序。
     * 上游的 category_wholesale 是它给我们的进货阶梯，这里存的是**我们对客**
     * 的阶梯 —— 两者不是一回事，混淆会导致按进货价卖给客户。
     */
    wholesaleTiers: text("wholesale_tiers"),
    /** 缺货时是否允许下预订单。原站的做法：避免客户流失到同行。 */
    reservable: integer("reservable", { mode: "boolean" }).notNull().default(false),
    /** 为 false 时不在店面展示，reason 说明原因（毛利不足 / 汇率过期 / 缺货）。 */
    sellable: integer("sellable", { mode: "boolean" }).notNull().default(false),
    unsellableReason: text("unsellable_reason"),
    stock: integer("stock").notNull().default(0),
    syncedAt: timestamp("synced_at").notNull(),
  },
  (table) => [
    uniqueIndex("products_pk").on(table.supplierId, table.code, table.race),
    index("products_sellable_idx").on(table.sellable),
    // 侧栏按分类筛选是最高频的查询。
    index("products_category_idx").on(table.categoryId, table.sellable),
  ],
);

/**
 * 商品分类快照。
 *
 * 发卡站的商品挂在分类树下，丢掉分类就没法还原它的浏览结构 ——
 * 而"按分类浏览"正是买家在这类站上的主要动作。
 */
export const categories = sqliteTable(
  "categories",
  {
    supplierId: text("supplier_id").notNull(),
    /** 上游的分类 id。 */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    /** 父分类的 externalId；顶级分类为 null。 */
    parentId: text("parent_id"),
    sort: integer("sort").notNull().default(0),
    /** 该分类下可售商品数。为 0 的分类不在侧栏展示，避免点进去是空的。 */
    sellableCount: integer("sellable_count").notNull().default(0),
    syncedAt: timestamp("synced_at").notNull(),
  },
  (table) => [
    uniqueIndex("categories_pk").on(table.supplierId, table.externalId),
    index("categories_sort_idx").on(table.sort),
  ],
);

export type Category = typeof categories.$inferSelect;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type Product = typeof products.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════
// 账号体系
//
// 原站有注册/登录/余额/购买记录。余额尤其重要 —— 它把「每单都走一次链上
// 转账」变成「充一次、买多次」，既省掉每单的链上手续费，也让复购几乎零摩擦。
// ═══════════════════════════════════════════════════════════════════════

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    /** scrypt/PBKDF2 派生值，绝不存明文也不存裸 SHA。 */
    passwordHash: text("password_hash").notNull(),
    /** 余额，以店铺展示币计。十进制字符串。 */
    balance: text("balance").notNull().default("0"),
    /** 累计消费额，用于将来的会员等级。 */
    totalSpent: text("total_spent").notNull().default("0"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** 随机 token 的哈希。库被读到也不能直接拿来冒充登录。 */
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/**
 * 余额流水。
 *
 * 余额本身是 users.balance 上的一个数，但**任何一次变动都必须有对应流水**。
 * 没有流水的余额是查不清的账：客户说少了 10 块，你无法证明。
 */
export const balanceTransactions = sqliteTable(
  "balance_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    /** topup = 充值；spend = 下单扣款；refund = 退款回充；adjust = 人工调整。 */
    kind: text("kind").notNull(),
    /** 带符号的变动额。充值为正，消费为负。 */
    amount: text("amount").notNull(),
    /** 变动后的余额，便于对账时逐笔核验。 */
    balanceAfter: text("balance_after").notNull(),
    orderId: text("order_id"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("balance_tx_user_idx").on(table.userId, table.createdAt)],
);

/**
 * 充值单。
 *
 * 与商品订单共用同一套链上收款机制（唯一金额打标），但结果不是发卡密，
 * 而是给余额加钱。单独成表是因为它没有商品、没有上游进货这两个概念。
 */
export const topups = sqliteTable(
  "topups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("awaiting_payment"),
    /** 到账后计入余额的金额。 */
    amount: text("amount").notNull(),
    chainId: text("chain_id").notNull(),
    payAddress: text("pay_address").notNull(),
    /** 打标后的唯一金额，与 orders.payAmount 同一套尾数空间。 */
    payAmount: text("pay_amount").notNull(),
    payWindowEndsAt: timestamp("pay_window_ends_at").notNull(),
    paidTxHash: text("paid_tx_hash"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    // 与订单同理：待付充值单的金额在链上必须唯一，否则无法归属到账。
    uniqueIndex("topups_pay_amount_open_unique")
      .on(table.chainId, table.payAmount)
      .where(sql`status = 'awaiting_payment'`),
    index("topups_user_idx").on(table.userId, table.createdAt),
  ],
);

// ═══════════════════════════════════════════════════════════════════════
// 优惠券
// ═══════════════════════════════════════════════════════════════════════

export const coupons = sqliteTable(
  "coupons",
  {
    code: text("code").primaryKey(),
    /** percent = 按比例折扣；amount = 直接减固定金额。 */
    kind: text("kind").notNull(),
    /** percent 时是 0-100 的折扣百分比；amount 时是减免金额。 */
    value: text("value").notNull(),
    /** 订单金额下限，低于此值不可用。 */
    minAmount: text("min_amount").notNull().default("0"),
    /** 总可用次数；null 表示不限。 */
    usageLimit: integer("usage_limit"),
    usedCount: integer("used_count").notNull().default(0),
    /** 每个用户可用次数；null 表示不限。匿名下单按邮箱计。 */
    perUserLimit: integer("per_user_limit"),
    /** 限定商品；留空表示全场通用。 */
    productCode: text("product_code"),
    expiresAt: timestamp("expires_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("coupons_active_idx").on(table.active)],
);

/** 核销记录。用于 perUserLimit 判定与事后对账。 */
export const couponRedemptions = sqliteTable(
  "coupon_redemptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    orderId: text("order_id").notNull(),
    /** 登录用户为 userId，匿名下单为邮箱。 */
    identity: text("identity").notNull(),
    discount: text("discount").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("coupon_redemptions_order_unique").on(table.orderId),
    index("coupon_redemptions_identity_idx").on(table.code, table.identity),
  ],
);

// ═══════════════════════════════════════════════════════════════════════
// 站点内容：公告与帮助文章
// ═══════════════════════════════════════════════════════════════════════

export const announcements = sqliteTable(
  "announcements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    /** 富文本正文。 */
    body: text("body").notNull(),
    /** 顶部通栏展示的一句话；留空则只在弹窗里出现。 */
    bannerText: text("banner_text"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** 首次访问是否弹窗。原站的做法，转化率影响明显。 */
    popup: integer("popup", { mode: "boolean" }).notNull().default(false),
    sort: integer("sort").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("announcements_active_idx").on(table.active, table.sort)],
);

/**
 * 帮助中心文章。
 *
 * 除了客服价值，这些是**站内唯一可以自由撰写的可索引内容** ——
 * 商品页的文案受上游限制，教程页不受限，是自然流量的主要来源。
 */
export const articles = sqliteTable(
  "articles",
  {
    slug: text("slug").primaryKey(),
    title: text("title").notNull(),
    /** 列表页与 meta description 用的摘要。 */
    summary: text("summary"),
    body: text("body").notNull(),
    published: integer("published", { mode: "boolean" }).notNull().default(true),
    /** 置顶。 */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    sort: integer("sort").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("articles_published_idx").on(table.published, table.sort)],
);

export type User = typeof users.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type Topup = typeof topups.$inferSelect;
