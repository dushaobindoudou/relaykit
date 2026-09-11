/**
 * 测试用的内存数据库上下文。
 *
 * 生产跑在 D1 上，测试跑在 better-sqlite3 上 —— 两者都是 SQLite，表结构
 * 由同一份 drizzle 迁移建出来，所以约束（唯一索引、部分索引）在测试里
 * **和生产一样会真的生效**。这很重要：余额扣款与优惠券限量的正确性
 * 有一半是靠数据库约束保证的，用假仓库（fake repository）测等于没测。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { RelayKitConfig } from "@/config/schema";
import { loadConfig } from "@/config/load";
import * as schema from "@/db/schema";
import { MockAdapter } from "@/supplier/mock/adapter";
import type { RelayKitContext } from "@/runtime/context";
import type { SupplierAdapter } from "@/supplier/types";

const MIGRATIONS_DIR = "drizzle";

/** 按文件名顺序执行全部迁移，与 wrangler d1 migrations apply 的口径一致。 */
function migrate(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // drizzle 用这个记号分隔语句；better-sqlite3 的 exec 能一次吃多条，
    // 但分开执行能让失败定位到具体语句。
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
}

export interface TestContextOptions {
  config?: Partial<RelayKitConfig>;
  supplier?: SupplierAdapter;
}

const BASE_RAW = {
  store: { name: "Test Shop", currency: "USDT", baseUrl: "https://test.example.com" },
  suppliers: [{ id: "demo", driver: "mock", currency: "CNY" }],
  pricing: {
    fx: { source: "static", rates: { CNY_USDT: "0.1389" } },
    markup: { type: "fixed", amount: "1" },
    minMarginPercent: 5,
    maxStalenessHours: 0,
  },
  payments: {
    windowMinutes: 30,
    chains: [{ id: "polygon", address: "0xTESTADDRESS", confirmations: 1 }],
  },
};

export interface TestContext extends RelayKitContext {
  /** 直接操作底层库，便于在测试里塞入前置数据。 */
  raw: Database.Database;
  close(): void;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const sqlite = new Database(":memory:");
  // 外键与 WAL 对内存库意义不大，但开启严格模式能让类型错误尽早暴露。
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);

  const config = loadConfig({ raw: structuredClone(BASE_RAW), env: {} });
  const merged = { ...config, ...options.config } as RelayKitConfig;

  const suppliers = new Map<string, SupplierAdapter>([
    ["demo", options.supplier ?? new MockAdapter()],
  ]);

  const db = drizzle(sqlite, { schema });

  /**
   * batch 垫片。
   *
   * `db.batch()` 是 D1 驱动独有的 —— better-sqlite3 驱动没有这个方法。
   * 用 better-sqlite3 的真实事务实现：一组语句要么全成要么全不成，
   * 与 D1 batch 的原子性语义一致（其实更严格，因为是本地事务）。
   *
   * 注意这里必须**同步**执行各条语句的 .run()：better-sqlite3 的事务是
   * 同步的，在事务里 await 会让事务在语句真正执行前就提交掉。
   * drizzle 的查询构造器有 .run()，正好是同步接口。
   */
  const withBatch = Object.assign(db, {
    batch: async (statements: { run: () => unknown }[]) => {
      const tx = sqlite.transaction(() => {
        for (const statement of statements) statement.run();
      });
      tx();
      return statements.map(() => ({ success: true }));
    },
  });

  return {
    config: merged,
    db: withBatch as unknown as RelayKitContext["db"],
    suppliers,
    raw: sqlite,
    close: () => sqlite.close(),
  };
}

/** 造一个用户，返回 id。 */
export function seedUser(
  context: TestContext,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  context.raw
    .prepare(
      `insert into users (id, email, password_hash, balance, total_spent, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.email ?? `${id}@example.com`,
      overrides.passwordHash ?? "pbkdf2$1$00$00",
      overrides.balance ?? "0",
      overrides.totalSpent ?? "0",
      overrides.createdAt ?? new Date().toISOString(),
    );
  return id;
}

/** 造一个可售商品。 */
export function seedProduct(
  context: TestContext,
  overrides: Partial<typeof schema.products.$inferInsert> = {},
): void {
  context.raw
    .prepare(
      `insert into products
        (supplier_id, code, race, name, cost, price, sellable, stock, delivery_way,
         wholesale_tiers, reservable, synced_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.supplierId ?? "demo",
      overrides.code ?? "ITEM",
      overrides.race ?? "",
      overrides.name ?? "Test Item",
      overrides.cost ?? "10",
      overrides.price ?? "20",
      overrides.sellable === false ? 0 : 1,
      overrides.stock ?? 100,
      overrides.deliveryWay ?? "auto",
      overrides.wholesaleTiers ?? null,
      overrides.reservable ? 1 : 0,
      overrides.syncedAt ?? new Date().toISOString(),
    );
}

/** 造一张优惠券。 */
export function seedCoupon(
  context: TestContext,
  overrides: Partial<typeof schema.coupons.$inferInsert> = {},
): string {
  const code = overrides.code ?? "SAVE";
  context.raw
    .prepare(
      `insert into coupons
        (code, kind, value, min_amount, usage_limit, used_count, per_user_limit,
         product_code, expires_at, active, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      code,
      overrides.kind ?? "amount",
      overrides.value ?? "5",
      overrides.minAmount ?? "0",
      overrides.usageLimit ?? null,
      overrides.usedCount ?? 0,
      overrides.perUserLimit ?? null,
      overrides.productCode ?? null,
      overrides.expiresAt ?? null,
      overrides.active === false ? 0 : 1,
      overrides.createdAt ?? new Date().toISOString(),
    );
  return code;
}
