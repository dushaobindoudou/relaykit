/**
 * 收款金额打标。
 *
 * 同一个收款地址靠唯一的小数尾数区分订单，省掉为每单派生地址的密钥管理。
 *
 * **核心约束：打标只能占用价格精度之后的小数位。**
 * 价格是两位小数（分），所以尾数从第三位开始。违反这条的后果是直接多收
 * 客户的钱 —— 曾经的实现让尾数占满全部 4 位小数，于是标价 4.06 的商品
 * 被要求支付 4.9852，多收 23%。
 *
 * 尾数空间 = 10^(decimals − 2)：
 *   decimals=4 → 100 个槽位，最多多收 0.0099
 *   decimals=6 → 10000 个槽位，最多多收 0.009999
 * 槽位越多越不容易撞号，代价只是多收不到一分钱。USDT 在主流链上都是
 * 6 位精度，所以 6 是安全且推荐的取值。
 */

import { Decimal } from "decimal.js";

/** 价格自身的精度。打标从这之后的位开始。 */
export const PRICE_DECIMALS = 2;

/** 该配置下可用的唯一金额数量。撞号重试耗尽时应当提示店主调大 decimals。 */
export function tagSlots(decimals: number): number {
  return 10 ** Math.max(1, decimals - PRICE_DECIMALS);
}

/**
 * 给金额加上随机尾数。
 *
 * 每次调用都重新取随机值，所以撞号后直接重调即可 —— 不要用「在上次基础上
 * 递增」的写法：递增一个完整单位会让第二次尝试多收客户一整块钱。
 */
export function tagAmount(
  amount: string,
  decimals: number,
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]!,
): string {
  const slots = tagSlots(decimals);
  const tag = random() % slots;

  // 全程 Decimal：浮点加法会在末位引入误差，而末位正是我们用来识别订单的。
  return new Decimal(amount)
    .plus(new Decimal(tag).div(new Decimal(10).pow(decimals)))
    .toFixed(decimals);
}

/** 打标额外多收的金额，用于展示与核对。 */
export function tagPremium(original: string, tagged: string): string {
  return new Decimal(tagged).minus(new Decimal(original)).toFixed();
}
