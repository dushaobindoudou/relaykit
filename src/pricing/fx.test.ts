/**
 * 动态汇率快照的测试。
 *
 * fxSnapshot 的核心行为：
 *   - fx.source = "static"：完全不碰 settings 和网络（单元测试确定性
 *     依赖这一点 —— 绝不能让"下单算价"悄悄依赖外网）。
 *   - fx.source = "coingecko"：settings 缓存（新鲜）→ 现场自愈（抓取
 *     +写回）→ 抓取失败给空汇率（拒绝上架的安全失败方向）。
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { fxSnapshot, FX_MAX_AGE_MS, refreshFx } from "@/pricing/fx";
import { createTestContext, type TestContext } from "@/testing/context";

const FRESH_AT = () => new Date(Date.now() - 60_000).toISOString(); // 1 分钟前
const STALE_AT = () => new Date(Date.now() - FX_MAX_AGE_MS - 3_600_000).toISOString(); // 过期 1 小时

async function seedFx(context: TestContext, rate: string, fetchedAt: string): Promise<void> {
  context.raw
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('fx_rates', ?, datetime('now'))",
    )
    .run(JSON.stringify({ CNY_USDT: rate, fetchedAt }));
}

/** 动态模式上下文：pricing 整段替换（测试 helper 是浅合并）。 */
function dynamicContext(): TestContext {
  return createTestContext({
    config: {
      pricing: {
        fx: { source: "coingecko", refreshMinutes: 30 },
        markup: { type: "fixed", amount: "1" },
        minMarginPercent: 5,
        maxDriftPercent: 0,
        maxStalenessHours: 24,
        rounding: { mode: "up", increment: "0.01" },
        overrides: [],
      },
    },
  });
}

/** 静态模式上下文：与 BASE_RAW 一致（0.1389，无 updatedAt = 永远新鲜）。 */
function staticContext(): TestContext {
  return createTestContext();
}

describe("fxSnapshot（source=static）", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("配置说了算：settings 里有缓存也不看，绝不发请求", async () => {
    const context = staticContext();
    await seedFx(context, "0.9999", FRESH_AT()); // 缓存若是被读，就会用这个错值
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const snapshot = await fxSnapshot(context);
    expect(snapshot.origin).toBe("static");
    expect(snapshot.rates.CNY_USDT).toBe("0.1389");
    expect(fetchSpy).not.toHaveBeenCalled();
    context.close();
  });
});

describe("fxSnapshot（source=coingecko）", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("新鲜缓存直接命中，不发请求", async () => {
    const context = dynamicContext();
    await seedFx(context, "0.1400", FRESH_AT());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const snapshot = await fxSnapshot(context);
    expect(snapshot.origin).toBe("cache");
    expect(snapshot.rates.CNY_USDT).toBe("0.1400");
    expect(fetchSpy).not.toHaveBeenCalled();
    context.close();
  });

  test("缓存过期时自愈：现场抓取并写回", async () => {
    const context = dynamicContext();
    await seedFx(context, "0.1400", STALE_AT());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tether: { cny: 7.2 } })),
    );

    const snapshot = await fxSnapshot(context);
    expect(snapshot.origin).toBe("fresh");
    expect(snapshot.rates.CNY_USDT).toBe("0.138889"); // 1 / 7.2

    // 写回 settings，下次命中缓存
    const again = await fxSnapshot(context);
    expect(again.origin).toBe("cache");
    context.close();
  });

  test("抓取失败给空汇率 —— 拒绝上架的安全失败方向", async () => {
    const context = dynamicContext();
    await seedFx(context, "0.1400", STALE_AT());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("网络炸了");
      }),
    );

    const snapshot = await fxSnapshot(context);
    expect(snapshot.rates).toEqual({});
    expect(snapshot.fetchedAt.getTime()).toBe(0);
    context.close();
  });

  test("荒谬的缓存值（越界）不被信任，走自愈", async () => {
    const context = dynamicContext();
    await seedFx(context, "99", FRESH_AT());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tether: { cny: 7.25 } })),
    );

    const snapshot = await fxSnapshot(context);
    expect(snapshot.origin).toBe("fresh");
    context.close();
  });
});

describe("refreshFx", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("coingecko 源：tether CNY 价取倒数", async () => {
    const context = dynamicContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tether: { cny: 7.1 } })),
    );

    const { rate, source } = await refreshFx(context.db);
    expect(source).toBe("coingecko");
    expect(rate).toBe("0.140845"); // 1 / 7.1
    context.close();
  });

  test("coingecko 失败落 er-api：USD 基准的 CNY 价取倒数", async () => {
    const context = dynamicContext();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("coingecko 限流");
        return Response.json({ rates: { CNY: 7.14 } });
      }),
    );

    const { rate, source } = await refreshFx(context.db);
    expect(source).toBe("er-api");
    expect(rate).toBe("0.140056"); // 1 / 7.14
    context.close();
  });
});
