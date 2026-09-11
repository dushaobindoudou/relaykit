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

    // —— 客户 ——
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
    /** 上游标签，逗号分隔。 */
    tags: text("tags"),
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
