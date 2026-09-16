/**
 * syncAll 的存在性清理：目录只允许包含配置里的供应商。
 * mock 供应商混进过生产（demo 商品挂在架上卖，根本无法履约）——
 * 这条护栏保证配置是对事实的唯一来源。
 */

import { describe, expect, test } from "vitest";

import { syncAll } from "@/catalog/sync";
import { categories, products } from "@/db/schema";
import { createTestContext } from "@/testing/context";

describe("syncAll 未配置供应商清理", () => {
  test("配置外的商品与分类被删除，配置内的保留", async () => {
    const context = createTestContext(); // 配置的供应商是 "demo"
    const db = context.db;

    // 配置内（demo）与配置外（ghost）各插一条商品 + 分类
    await db.insert(products).values([
      {
        supplierId: "demo",
        code: "KEEP-1",
        race: "",
        name: "保留的商品",
        cost: "1",
        sellable: false,
        syncedAt: new Date().toISOString(),
      },
      {
        supplierId: "ghost",
        code: "DROP-1",
        race: "",
        name: "幽灵供应商商品",
        cost: "1",
        sellable: true,
        syncedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(categories).values([
      {
        supplierId: "demo",
        externalId: "c1",
        name: "保留分类",
        sort: 0,
        sellableCount: 0,
        syncedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        supplierId: "ghost",
        externalId: "c2",
        name: "幽灵分类",
        sort: 0,
        sellableCount: 0,
        syncedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    // mock 供应商同步失败没关系 —— 清理发生在适配器调用之前。
    await syncAll(context);

    // mock 适配器自己会写回 demo 供应商的商品行 —— 断言的语义是：
    // 配置外（ghost）清干净、配置内（demo）仍在。
    const left = await db.select({ supplierId: products.supplierId }).from(products);
    expect(left.map((row) => row.supplierId)).toContain("demo");
    expect(left.map((row) => row.supplierId)).not.toContain("ghost");

    const cats = await db.select({ supplierId: categories.supplierId }).from(categories);
    expect(cats.map((row) => row.supplierId)).toContain("demo");
    expect(cats.map((row) => row.supplierId)).not.toContain("ghost");

    context.close();
  });
});
