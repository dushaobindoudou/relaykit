/**
 * 双币展示换算测试：汇率缺失不展示（null）、越界汇率不信任、四舍五入口径。
 */

import { describe, expect, test } from "vitest";

import { cnyAmount, cnyNote } from "@/pricing/cny";

describe("cnyAmount / cnyNote", () => {
  test("基础换算：2 USDT @ 0.148694 → ¥13.45", () => {
    expect(cnyAmount("2", "0.148694")).toBe("13.45");
    expect(cnyNote("2", "0.148694")).toBe("≈ ¥13.45");
  });

  test("带数量的总价换算", () => {
    expect(cnyAmount("13.458317", "0.148694")).toBe("90.51");
  });

  test("汇率缺失/空串 → null（只显示主价，绝不显示错价）", () => {
    expect(cnyAmount("2", null)).toBeNull();
    expect(cnyAmount("2", "")).toBeNull();
    expect(cnyAmount("2", undefined)).toBeNull();
    expect(cnyNote("2", null)).toBeNull();
  });

  test("荒谬汇率（0/负数/非数值）→ null", () => {
    expect(cnyAmount("2", "0")).toBeNull();
    expect(cnyAmount("2", "-0.14")).toBeNull();
    expect(cnyAmount("2", "abc")).toBeNull();
  });

  test("四舍五入到两位", () => {
    expect(cnyAmount("1", "0.148694")).toBe("6.73"); // 6.7252 → 6.73
  });
});
