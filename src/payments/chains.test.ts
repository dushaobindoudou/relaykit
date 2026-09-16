/**
 * 链上金额换算测试。
 *
 * 这个文件盯的是一类会让金额差 10^12 倍的错误：各链 USDT 的小数位不同。
 * BSC 上是 18 位，Ethereum / Polygon / Tron 上是 6 位。搞错的后果是
 * 要么所有付款都匹配不上，要么把 0.000005 当成 5 白送一单货。
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { CHAIN_SPECS, fromRawAmount, toRawAmount } from "./chains";

describe("各链参数", () => {
  test("BSC 的 USDT 是 18 位小数，与其它链不同", () => {
    // 这条断言存在的唯一目的就是防止有人"顺手统一成 6 位"。
    assert.equal(CHAIN_SPECS.bsc?.decimals, 18);
  });

  test("Ethereum / Polygon / Tron / Base 的 USDT 都是 6 位", () => {
    assert.equal(CHAIN_SPECS.ethereum?.decimals, 6);
    assert.equal(CHAIN_SPECS.polygon?.decimals, 6);
    assert.equal(CHAIN_SPECS.tron?.decimals, 6);
    // Base 的官方 USDT（0xfde4…9bb2）合约链上实测 symbol=USDT decimals=6。
    assert.equal(CHAIN_SPECS.base?.decimals, 6);
  });

  test("每条链都配了合约地址", () => {
    for (const [name, spec] of Object.entries(CHAIN_SPECS)) {
      assert.ok(spec.token.length > 20, `${name} 缺少合约地址`);
    }
  });
});

describe("原始值 → 十进制字符串", () => {
  test("6 位小数", () => {
    assert.equal(fromRawAmount(5_000_000n, 6), "5");
    assert.equal(fromRawAmount(5_170_000n, 6), "5.17");
    assert.equal(fromRawAmount(5_173_456n, 6), "5.173456");
  });

  test("18 位小数（BSC）", () => {
    assert.equal(fromRawAmount(5_000_000_000_000_000_000n, 18), "5");
    assert.equal(fromRawAmount(5_170_000_000_000_000_000n, 18), "5.17");
  });

  test("末尾的零被裁掉，便于与订单金额做字符串比较", () => {
    assert.equal(fromRawAmount(1_100_000n, 6), "1.1");
    assert.equal(fromRawAmount(1_000_000n, 6), "1");
  });

  test("小于 1 的金额补齐前导零", () => {
    assert.equal(fromRawAmount(1_234n, 6), "0.001234");
    assert.equal(fromRawAmount(1n, 6), "0.000001");
  });

  test("零", () => {
    assert.equal(fromRawAmount(0n, 6), "0");
  });

  test("超过 Number 安全范围的原始值不丢精度", () => {
    // 18 位小数下，1000 USDT 的原始值已经远超 Number.MAX_SAFE_INTEGER。
    // 用 Number 转一次就会丢掉末尾几位 —— 而那几位正是匹配订单的尾数。
    const raw = 1_000_123_456_789_012_345_678n;
    assert.ok(raw > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(fromRawAmount(raw, 18), "1000.123456789012345678");
  });
});

describe("十进制字符串 → 原始值", () => {
  test("往返一致（6 位）", () => {
    for (const amount of ["5", "5.17", "0.000001", "1234.567891"]) {
      assert.equal(fromRawAmount(toRawAmount(amount, 6), 6), amount);
    }
  });

  test("往返一致（18 位）", () => {
    for (const amount of ["5", "5.17", "1000.123456789012345678"]) {
      assert.equal(fromRawAmount(toRawAmount(amount, 18), 18), amount);
    }
  });

  test("超出精度的小数位被截断而不是进位", () => {
    // 宁可少算也不要凭空多出金额 —— 进位会让我们认为客户付得比实际多。
    assert.equal(toRawAmount("1.9999999", 6), 1_999_999n);
  });

  test("不带小数点的整数", () => {
    assert.equal(toRawAmount("7", 6), 7_000_000n);
  });
});

describe("跨链一致性", () => {
  test("同一笔 5.1234 USDT 在 6 位与 18 位下换算回来都是同一个金额", () => {
    const amount = "5.1234";
    assert.equal(fromRawAmount(toRawAmount(amount, 6), 6), amount);
    assert.equal(fromRawAmount(toRawAmount(amount, 18), 18), amount);
  });

  test("用错小数位会产生差 10^12 倍的结果（这正是要防的）", () => {
    const raw = toRawAmount("5", 18);
    // 拿 18 位的原始值按 6 位解，会读成一个天文数字。
    assert.equal(fromRawAmount(raw, 6), "5000000000000");
  });
});
