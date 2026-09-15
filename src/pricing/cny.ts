/**
 * 双币展示：USDT 主价 + 人民币参考价。
 *
 * 结算币是 USDT，但客户脑子里的是人民币 —— 每个价格旁边给一个
 * 「≈ ¥xx.xx」参考值，按当前 fx 快照折算（两位小数）。
 * 汇率不可用时返回 null，调用方**只显示主价**，绝不显示一个
 * 错误或过期的人民币数。
 */

import { Decimal } from "decimal.js";

/** USDT 金额 → 人民币金额串（两位小数）；汇率缺失/无效返回 null。 */
export function cnyAmount(
  usdt: string | number,
  cnyUsdt: string | null | undefined,
): string | null {
  if (cnyUsdt === null || cnyUsdt === undefined || cnyUsdt === "") return null;
  // 非数值串会让 Decimal 构造直接抛错（不是返回 NaN）—— 一律当作汇率不可用。
  let rate: Decimal;
  try {
    rate = new Decimal(cnyUsdt);
  } catch {
    return null;
  }
  if (!rate.isFinite() || rate.lte(0)) return null;
  return new Decimal(usdt).div(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** 带前缀的展示串「≈ ¥13.45」；汇率不可用返回 null。 */
export function cnyNote(
  usdt: string | number,
  cnyUsdt: string | null | undefined,
): string | null {
  const amount = cnyAmount(usdt, cnyUsdt);
  return amount === null ? null : `≈ ¥${amount}`;
}
