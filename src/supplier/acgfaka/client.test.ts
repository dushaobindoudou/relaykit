/**
 * 适配器对着假上游的端到端测试。
 *
 * 重点不在"顺利下单能拿到卡"，而在**钱的去向在每条异常路径上都是确定的**：
 * 下单超时、上游已扣款、余额不足、WAF 拦截。这几条在真站上无法安全复现，
 * 假上游存在的意义就是把它们钉住。
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AcgFakaAdapter } from "./client.ts";
import { MockUpstream } from "./mock-upstream.ts";
import type { PurchaseRequest } from "../types.ts";

const APP_ID = "42";
const APP_KEY = "mock-app-key";

const buildProducts = () => [
  {
    code: "GEMINI1Y",
    name: "Gemini Pro 1 Year",
    listPrice: { "随机成品质保1年": "48", "美国成品质保1年": "50" },
    factoryPrice: { "随机成品质保1年": "30", "美国成品质保1年": "32" },
    stock: 10,
  },
  {
    code: "SINGLE",
    name: "Single Spec Item",
    listPrice: { "": "20" },
    factoryPrice: { "": "16" },
    stock: 3,
  },
];

let upstream: MockUpstream;
let adapter: AcgFakaAdapter;
let domain: string;

const request = (overrides: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  code: "GEMINI1Y",
  race: "随机成品质保1年",
  quantity: 1,
  requestNo: `req-${Math.random().toString(36).slice(2)}`,
  ...overrides,
});

before(async () => {
  upstream = new MockUpstream({
    appId: APP_ID,
    appKey: APP_KEY,
    products: buildProducts(),
    initialBalance: "1000",
  });
  domain = await upstream.start();
});

after(async () => {
  await upstream.stop();
});

beforeEach(() => {
  // 每个用例一份干净的商品/余额/订单状态，避免相互串扰。
  Object.assign(upstream, {});
  for (const key of Object.keys(upstream.faults)) {
    delete (upstream.faults as Record<string, unknown>)[key];
  }
  adapter = new AcgFakaAdapter({
    domain,
    appId: APP_ID,
    appKey: APP_KEY,
    timeoutMs: 1_500,
  });
});

describe("鉴权", () => {
  test("签名正确时 connect 通过，说明我们的签名实现与协议自洽", async () => {
    const result = await adapter.connect();
    assert.equal(result.shopName, "mock-shop");
    assert.match(result.balance, /^\d+\.\d{2}$/);
  });

  test("app_key 错误时上游回『密钥错误』而不是放行", async () => {
    const wrong = new AcgFakaAdapter({ domain, appId: APP_ID, appKey: "wrong" });
    await assert.rejects(() => wrong.connect(), /密钥错误/);
  });

  test("app_id 不存在时报『商户ID不存在』，与签名错误区分开", async () => {
    const wrong = new AcgFakaAdapter({ domain, appId: "999", appKey: APP_KEY });
    await assert.rejects(() => wrong.connect(), /商户ID不存在/);
  });
});

describe("商品与价格", () => {
  test("多规格商品把 category_factory 映射成 costByRace", async () => {
    const product = await adapter.getProduct("GEMINI1Y");
    assert.deepEqual(product.races, ["随机成品质保1年", "美国成品质保1年"]);
    assert.equal(product.costByRace["随机成品质保1年"], "30");
    assert.equal(product.listPriceByRace["随机成品质保1年"], "48");
  });

  test("单规格商品用顶层 price / factory_price，键为空串", async () => {
    const product = await adapter.getProduct("SINGLE");
    assert.deepEqual(product.races, []);
    assert.equal(product.costByRace[""], "16");
  });

  test("getProduct 带回上游货币代码，供结算币种不一致时告警", async () => {
    const product = await adapter.getProduct("GEMINI1Y");
    assert.equal(product.currencyCode, "CNY");
  });

  test("quote 按数量现算，用于下单前校验缓存成本价没过期", async () => {
    assert.equal(await adapter.quote("GEMINI1Y", 3, "随机成品质保1年"), "90.00");
  });

  test("listProducts 摊平分类树", async () => {
    const products = await adapter.listProducts();
    assert.deepEqual(
      products.map((item) => item.code).sort(),
      ["GEMINI1Y", "SINGLE"],
    );
  });
});

describe("正常下单", () => {
  test("成功时返回可对账的 tradeNo 与卡密，并扣减上游余额", async () => {
    const before = Number((await adapter.connect()).balance);
    const outcome = await adapter.purchase(request());

    assert.equal(outcome.kind, "success");
    assert.ok(outcome.kind === "success" && outcome.supplierTradeNo.startsWith("MOCK"));
    assert.match(outcome.kind === "success" ? outcome.secret : "", /^SECRET-/);

    const after = Number((await adapter.connect()).balance);
    assert.equal(before - after, 30);
  });

  test("拿到的 tradeNo 可以事后 query 回卡密（日终对账依赖这条）", async () => {
    const outcome = await adapter.purchase(request());
    assert.equal(outcome.kind, "success");
    if (outcome.kind !== "success") return;

    const queried = await adapter.queryOrder(outcome.supplierTradeNo);
    assert.equal(queried?.secret, outcome.secret);
  });

  test("查不存在的订单返回 null 而不是抛错（否定答复不是故障）", async () => {
    assert.equal(await adapter.queryOrder("NOPE"), null);
  });
});

describe("明确拒绝：钱一定没扣", () => {
  test("库存不足归类为 rejected，可以安全地失败并退款给客户", async () => {
    const outcome = await adapter.purchase(request({ code: "SINGLE", quantity: 99 }));
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.kind === "rejected" && outcome.insufficientBalance, false);
  });

  test("余额不足被单独标记 —— 它不是单笔问题，是整站停摆的前兆", async () => {
    upstream.faults.tradeRejectWith = "余额不足";
    const outcome = await adapter.purchase(request());
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.kind === "rejected" && outcome.insufficientBalance, true);
  });
});

describe("不确定状态：唯一可能丢钱的路径", () => {
  test("上游提交后挂断 → 判定为 ambiguous，绝不当成失败", async () => {
    upstream.faults.tradeHangUpAfterCommit = true;
    const outcome = await adapter.purchase(request());
    assert.equal(outcome.kind, "ambiguous");
  });

  test("超时 → ambiguous", async () => {
    upstream.faults.tradeNeverRespond = true;
    const outcome = await adapter.purchase(request({ code: "SINGLE" }));
    assert.equal(outcome.kind, "ambiguous");
  });

  test("WAF 拦截页（非 JSON）→ ambiguous，不能当成业务拒绝", async () => {
    upstream.faults.respondWithGarbage = true;
    const outcome = await adapter.purchase(request());
    assert.equal(outcome.kind, "ambiguous");
  });

  test(
    "已扣款的不确定单：resolveAmbiguous 判定为 charged_unrecoverable，" +
      "而不是误判成没扣款去退客户的钱",
    async () => {
      const req = request();

      upstream.faults.tradeHangUpAfterCommit = true;
      const outcome = await adapter.purchase(req);
      assert.equal(outcome.kind, "ambiguous");

      // 上游侧确实已落单 —— 这正是危险所在。
      assert.ok(upstream.committedRequestNos.includes(req.requestNo));

      delete upstream.faults.tradeHangUpAfterCommit;
      const resolution = await adapter.resolveAmbiguous(req);

      assert.equal(resolution.kind, "charged_unrecoverable");
    },
  );

  test("未扣款的不确定单：resolveAmbiguous 补打成功并拿回卡密", async () => {
    const req = request();

    upstream.faults.tradeNeverRespond = true;
    const outcome = await adapter.purchase(req);
    assert.equal(outcome.kind, "ambiguous");

    // 上游没有落单，所以补打应当成功。
    assert.ok(!upstream.committedRequestNos.includes(req.requestNo));

    delete upstream.faults.tradeNeverRespond;
    const resolution = await adapter.resolveAmbiguous(req);

    assert.equal(resolution.kind, "recovered");
    assert.ok(resolution.kind === "recovered" && resolution.purchase.secret !== "");
  });

  test("恢复时上游明确报业务错 → not_charged，可以安全退款", async () => {
    const req = request();

    upstream.faults.tradeNeverRespond = true;
    assert.equal((await adapter.purchase(req)).kind, "ambiguous");

    delete upstream.faults.tradeNeverRespond;
    upstream.faults.tradeRejectWith = "商品已下架";
    const resolution = await adapter.resolveAmbiguous(req);

    assert.equal(resolution.kind, "not_charged");
  });

  test("恢复时仍然超时 → still_ambiguous，交人工，不再自动重试", async () => {
    const req = request();
    upstream.faults.tradeNeverRespond = true;

    assert.equal((await adapter.purchase(req)).kind, "ambiguous");
    const resolution = await adapter.resolveAmbiguous(req);

    assert.equal(resolution.kind, "still_ambiguous");
  });

  test("成功但缺 tradeNo → ambiguous，不把无法对账的卡发给客户", async () => {
    // 上游确实落了单（余额扣了、卡分配了），但 body 里没有 tradeNo，
    // 我们事后无从 query。这种卡不能直接发给客户 —— 一旦有售后就是死账。
    upstream.faults.tradeOmitTradeNo = true;

    const outcome = await adapter.purchase(request());

    assert.equal(outcome.kind, "ambiguous");
    assert.match(
      outcome.kind === "ambiguous" ? outcome.reason : "",
      /tradeNo/,
    );
  });
});
