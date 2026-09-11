/**
 * 金额打标测试。
 *
 * 这些用例是为一个真实发生过的 bug 写的：原实现让随机尾数占满全部小数位，
 * 标价 4.06 的商品被要求支付 4.9852 —— 多收 23%。而且撞号重试时还会
 * 再整整多加 1 个单位。两条都直接体现为「向客户多收钱」，是最不能容忍的
 * 一类错误，所以这里用明确的上界断言把它钉死。
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { tagAmount, tagPremium, tagSlots, PRICE_DECIMALS } from "./tagging";

/** 确定性随机源，便于断言具体数值。 */
const fixed = (value: number) => () => value;

describe("尾数只占用价格精度之后的位", () => {
  test("标价两位小数时，4 位打标最多只多收 0.0099", () => {
    // 曾经的 bug：这里会得到 4.9852。
    const worst = tagAmount("4.06", 4, fixed(9999));
    assert.equal(worst, "4.0699");
    assert.equal(tagPremium("4.06", worst), "0.0099");
  });

  test("6 位打标最多只多收 0.009999", () => {
    const worst = tagAmount("4.06", 6, fixed(999_999));
    assert.equal(worst, "4.069999");
    assert.ok(Number(tagPremium("4.06", worst)) < 0.01);
  });

  test("穷举所有槽位，多收的金额永远小于一分钱", () => {
    for (const decimals of [4, 5, 6]) {
      const slots = tagSlots(decimals);
      for (const tag of [0, 1, Math.floor(slots / 2), slots - 1]) {
        const tagged = tagAmount("12.34", decimals, fixed(tag));
        const premium = Number(tagPremium("12.34", tagged));
        assert.ok(
          premium >= 0 && premium < 0.01,
          `decimals=${decimals} tag=${tag} 多收了 ${premium}`,
        );
      }
    }
  });

  test("尾数为 0 时金额与原价相等（只是补齐小数位）", () => {
    assert.equal(tagAmount("4.06", 4, fixed(0)), "4.0600");
    assert.equal(tagPremium("4.06", "4.0600"), "0");
  });
});

describe("重试不会累加整数单位", () => {
  test("连续调用只是换一个尾数，不会越加越多", () => {
    // 曾经的 bug：第 N 次尝试会多加 N 个完整单位。
    const attempts = [0, 1, 2, 3, 4].map((i) =>
      tagAmount("10.00", 4, fixed(i * 7)),
    );

    for (const amount of attempts) {
      const premium = Number(tagPremium("10.00", amount));
      assert.ok(premium < 0.01, `重试后多收了 ${premium}`);
    }
  });
});

describe("槽位数量", () => {
  test("槽位 = 10^(decimals − 价格精度)", () => {
    assert.equal(PRICE_DECIMALS, 2);
    assert.equal(tagSlots(4), 100);
    assert.equal(tagSlots(6), 10_000);
  });

  test("decimals 小于等于价格精度时至少留一位，不会退化成零槽位", () => {
    // 零槽位会让取模除以 0，产生 NaN 金额。
    assert.ok(tagSlots(2) >= 10);
    assert.ok(tagSlots(1) >= 10);
  });
});

describe("精度", () => {
  test("不使用浮点：末位不引入误差", () => {
    // 末位正是用来识别订单的，浮点误差会让金额匹配不上。
    assert.equal(tagAmount("0.10", 6, fixed(3)), "0.100003");
    assert.equal(tagAmount("1999999.99", 6, fixed(1)), "1999999.990001");
  });

  test("整数价格也被正确补齐", () => {
    assert.equal(tagAmount("25", 4, fixed(42)), "25.0042");
  });
});

describe("唯一性", () => {
  test("不同尾数产生不同金额（这是打标的全部意义）", () => {
    const seen = new Set<string>();
    for (let tag = 0; tag < 100; tag += 1) {
      seen.add(tagAmount("5.00", 4, fixed(tag)));
    }
    assert.equal(seen.size, 100);
  });
});
