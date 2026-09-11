/**
 * 配置加载测试。
 *
 * 这一层的价值全在"**在启动期就拦住**"：每一条被这里挡下的错误配置，
 * 若放行都会在生产上以"客户付了钱却发不了货"或"按错误价格成交"的形式出现。
 * 所以用例几乎都在断言「拒绝加载」而不是「成功加载」。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";

import { ConfigError, loadConfig } from "./load";

const ENV_KEYS = ["TEST_APP_KEY", "TEST_ADDR", "TEST_OPTIONAL"];

/**
 * 未经校验的配置草稿。显式写出这个类型，是为了让用例能自由改写字段
 * （比如把 rates 清空）—— 直接返回对象字面量的话，TS 会把 rates 推断成
 * 只含 CNY_USDT 这一个键的具体类型，赋 {} 就报错。
 */
interface RawDraft {
  store: { name: string; currency: string; baseUrl: string };
  suppliers: Record<string, unknown>[];
  pricing: {
    fx: { source: string; rates: Record<string, string> };
    markup: { type: string; amount: string | number };
    minMarginPercent: number;
    overrides?: unknown;
  };
  payments: { chains: Record<string, unknown>[] };
}

/** 一份最小可用配置，各用例在它之上做局部破坏。 */
const validRaw = (): RawDraft => ({
  store: { name: "Demo", currency: "USDT", baseUrl: "https://shop.example.com" },
  suppliers: [
    {
      id: "primary",
      driver: "acgfaka",
      domain: "https://upstream.example.com",
      appId: "42",
      appKey: "${TEST_APP_KEY}",
      currency: "CNY",
    },
  ],
  pricing: {
    fx: { source: "static", rates: { CNY_USDT: "0.1389" } },
    markup: { type: "fixed", amount: "1" },
    minMarginPercent: 3,
  },
  payments: {
    chains: [{ id: "polygon", address: "${TEST_ADDR}", confirmations: 30 }],
  },
});

beforeEach(() => {
  process.env.TEST_APP_KEY = "s3cret";
  process.env.TEST_ADDR = "0xabc";
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("环境变量插值", () => {
  test("${VAR} 被展开，密钥因而不必写进配置文件", () => {
    const config = loadConfig({ raw: validRaw() });
    assert.equal(config.suppliers[0]?.appKey, "s3cret");
    assert.equal(config.payments.chains[0]?.address, "0xabc");
  });

  test("缺失的环境变量直接拒绝加载，而不是静默留空", () => {
    // 留空会让 appKey 变成 ""，然后在第一笔真实订单上以"密钥错误"爆出来。
    delete process.env.TEST_APP_KEY;
    assert.throws(
      () => loadConfig({ raw: validRaw() }),
      (error: unknown) =>
        error instanceof ConfigError && /TEST_APP_KEY/.test(error.message),
    );
  });

  test("报错信息指出是配置里的哪个字段引用了它", () => {
    delete process.env.TEST_ADDR;
    try {
      loadConfig({ raw: validRaw() });
      assert.fail("应当抛错");
    } catch (error) {
      assert.match((error as Error).message, /payments\.chains\[0\]\.address/);
    }
  });

  test("${VAR:-默认值} 在变量缺失时回落，便于本地开发", () => {
    const raw = validRaw();
    raw.store.name = "${TEST_OPTIONAL:-Local Dev Shop}";
    assert.equal(loadConfig({ raw }).store.name, "Local Dev Shop");
  });

  test("空字符串的环境变量视同未设置（避免 export FOO= 造成的假配置）", () => {
    process.env.TEST_APP_KEY = "";
    assert.throws(() => loadConfig({ raw: validRaw() }), ConfigError);
  });
});

describe("字段校验", () => {
  test("acgfaka 驱动缺 appKey 时在启动期就报错", () => {
    const raw = validRaw();
    delete (raw.suppliers[0] as Record<string, unknown>).appKey;
    assert.throws(
      () => loadConfig({ raw }),
      (error: unknown) => error instanceof ConfigError && /appKey/.test(error.message),
    );
  });

  test("mock 驱动不要求 domain/appId/appKey，开箱即可跑演示", () => {
    const raw = validRaw();
    raw.suppliers = [{ id: "demo", driver: "mock", currency: "USDT" } as never];
    raw.pricing.fx = { source: "static", rates: {} };
    assert.doesNotThrow(() => loadConfig({ raw }));
  });

  test("金额必须是十进制字符串，浮点数写法被拒", () => {
    const raw = validRaw();
    (raw.pricing.markup as Record<string, unknown>).amount = 1.5;
    assert.throws(() => loadConfig({ raw }), ConfigError);
  });

  test("科学计数法被拒（1e-2 这种写法在金额里是事故源）", () => {
    const raw = validRaw();
    raw.pricing.markup.amount = "1e-2";
    assert.throws(() => loadConfig({ raw }), ConfigError);
  });

  test("至少要有一个上游", () => {
    const raw = validRaw();
    raw.suppliers = [];
    assert.throws(() => loadConfig({ raw }), ConfigError);
  });

  test("至少要有一条收款链", () => {
    const raw = validRaw();
    raw.payments.chains = [];
    assert.throws(() => loadConfig({ raw }), ConfigError);
  });
});

describe("跨字段一致性", () => {
  test("上游结算币与展示币不同却没配汇率时拒绝加载", () => {
    const raw = validRaw();
    raw.pricing.fx = { source: "static", rates: {} };
    assert.throws(
      () => loadConfig({ raw }),
      (error: unknown) => error instanceof ConfigError && /CNY_USDT/.test(error.message),
    );
  });

  test("同币种时不要求汇率", () => {
    const raw = validRaw();
    raw.suppliers[0]!.currency = "USDT";
    raw.pricing.fx = { source: "static", rates: {} };
    assert.doesNotThrow(() => loadConfig({ raw }));
  });

  test("overrides 指向不存在的 supplier 时报错（改名后忘了同步的典型）", () => {
    const raw = validRaw();
    (raw.pricing as Record<string, unknown>).overrides = [
      { supplier: "typo", code: "A", markup: { type: "fixed", amount: "1" } },
    ];
    assert.throws(
      () => loadConfig({ raw }),
      (error: unknown) => error instanceof ConfigError && /typo/.test(error.message),
    );
  });

  test("同一条链配置两次会导致重复入账，拒绝加载", () => {
    const raw = validRaw();
    raw.payments.chains = [
      { id: "polygon", address: "0xa", confirmations: 30 },
      { id: "polygon", address: "0xb", confirmations: 30 },
    ] as never;
    assert.throws(
      () => loadConfig({ raw }),
      (error: unknown) => error instanceof ConfigError && /重复入账/.test(error.message),
    );
  });

  test("所有链都禁用时拒绝加载 —— 店能开但没人付得了款", () => {
    const raw = validRaw();
    raw.payments.chains = [
      { id: "polygon", address: "0xa", enabled: false },
    ] as never;
    assert.throws(() => loadConfig({ raw }), ConfigError);
  });

  test("关闭毛利保护会被当作问题拦下，除非显式 allowWarnings", () => {
    const raw = validRaw();
    raw.pricing.minMarginPercent = 0;

    assert.throws(() => loadConfig({ raw }), ConfigError);
    assert.doesNotThrow(() => loadConfig({ raw, allowWarnings: true }));
  });
});

describe("默认值", () => {
  test("未填的项落到安全的默认值上", () => {
    const config = loadConfig({ raw: validRaw() });

    assert.equal(config.payments.windowMinutes, 30);
    assert.equal(config.pricing.rounding.mode, "up"); // 向上取整，保毛利
    assert.equal(config.fulfillment.mode, "auto");
    assert.equal(config.fulfillment.haltSalesOnLowBalance, true); // 余额不足即停售
    assert.equal(config.pricing.maxStalenessHours, 24);
  });

  test("返回的配置被冻结，避免运行期被某处偷偷改掉", () => {
    const config = loadConfig({ raw: validRaw() });
    assert.throws(() => {
      (config as { store: { name: string } }).store = { name: "hacked" };
    });
  });
});

describe("文件加载", () => {
  test("文件不存在时给出可操作的提示而不是裸异常", () => {
    try {
      loadConfig({ path: "/tmp/definitely-not-here-relaykit.yaml" });
      assert.fail("应当抛错");
    } catch (error) {
      assert.match((error as Error).message, /relaykit\.config\.example\.yaml/);
    }
  });
});
