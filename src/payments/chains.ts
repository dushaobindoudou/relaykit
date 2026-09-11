/**
 * 各链的 USDT 参数。
 *
 * ⚠️ **小数位是这个文件里最危险的常量。**
 * BSC 上的 USDT（官方名 BSC-USD）是 **18 位**小数，而 Ethereum / Polygon /
 * Tron 上的 USDT 都是 **6 位**。用错会让金额差 10^12 倍：
 * 客户转了 5 USDT，我们按 6 位去解 18 位的原始值，会读成 0.000005，
 * 匹配不上任何订单；反过来则会把 0.000005 读成 5，白送一单货。
 *
 * 合约地址同样不能弄错 —— 转到山寨合约上的代币对我们毫无价值，
 * 而监听错合约会让真实付款被完全忽略。
 */

export interface ChainSpec {
  /** EVM 链 id；Tron 不是 EVM，用 null 标识。 */
  chainId: number | null;
  /** USDT 合约地址。 */
  token: string;
  /** ⚠️ 见文件头注释。 */
  decimals: number;
  /** 默认公共 RPC。生产环境强烈建议在配置里换成自备节点。 */
  rpcUrl: string;
  /** 单次 eth_getLogs 允许的最大区块跨度。公共节点普遍有限制。 */
  maxBlockRange: number;
  /** 该链平均出块时间（秒），用于估算首次扫描的起点。 */
  blockSeconds: number;
}

export const CHAIN_SPECS: Record<string, ChainSpec> = {
  polygon: {
    chainId: 137,
    token: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals: 6,
    rpcUrl: "https://polygon-rpc.com",
    maxBlockRange: 2_000,
    blockSeconds: 2,
  },
  bsc: {
    chainId: 56,
    // BSC-USD。注意这条链上是 18 位小数，与其它链不同。
    token: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
    rpcUrl: "https://bsc-dataseed.binance.org",
    maxBlockRange: 2_000,
    blockSeconds: 3,
  },
  ethereum: {
    chainId: 1,
    token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    rpcUrl: "https://eth.llamarpc.com",
    maxBlockRange: 1_000,
    blockSeconds: 12,
  },
  tron: {
    chainId: null,
    token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    decimals: 6,
    rpcUrl: "https://api.trongrid.io",
    maxBlockRange: 0, // Tron 走 TronGrid 的事件接口，不按区块范围拉
    blockSeconds: 3,
  },
};

/** ERC20 Transfer(address,address,uint256) 的事件签名哈希。 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * 把链上的整数原始值换算成十进制字符串。
 *
 * 不用 Number：18 位小数的原始值远超 Number.MAX_SAFE_INTEGER，
 * 转一次就丢精度，而丢掉的那几位正是我们用来匹配订单的尾数。
 */
export function fromRawAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0");

  const trimmed = fraction.replace(/0+$/, "");
  const text = trimmed ? `${whole}.${trimmed}` : whole.toString();
  return negative ? `-${text}` : text;
}

/** 反向换算，用于按金额精确匹配订单。 */
export function toRawAmount(amount: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  // 多余的小数位直接截断而不是四舍五入：宁可少算也不要凭空多出金额。
  const padded = fraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** 从 32 字节的 topic 里取出地址（后 20 字节），统一成小写便于比较。 */
export function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}
