/**
 * 出款器 —— 自动中转采购里「把钱付给上游」的那只手。
 *
 * 客户付给我们 X×1.2 之后，我们用热钱包把上游要的精确 USDT 金额转过去，
 * 上游按「到账金额完全一致」自动发货。签名与广播都在 Workers 里完成
 * （ethers v6 是纯 JS 实现，走 fetch RPC，无 Node 依赖）。
 *
 * 安全边界，全部是刻意的：
 *   - 私钥只从 context.secrets 读，永远不落库、不进日志；
 *   - 金额用上游收银台的原样字符串 parseUnits，绝不自己换算 ——
 *     他们按金额对账，差一位小数就是丢一笔货；
 *   - 单笔上限护栏在调用方（auto-purchase）做，本模块只管签名与广播；
 *   - 只支持 EVM 链（polygon/bsc）。TRC20 是另一套签名体系，明确不做，
 *     配了也只会转人工，绝不假装支持。
 */

import { Wallet, JsonRpcProvider, parseUnits, Interface } from "ethers";

import { CHAIN_SPECS } from "./chains";

/** 由收银台链名映射到我们支持的出款链。解析不了返回 null（转人工）。 */
export function chainFromLabel(label: string): "polygon" | "bsc" | null {
  const normalized = label.toLowerCase();
  if (normalized.includes("polygon")) return "polygon";
  if (normalized.includes("bep") || normalized.includes("bsc")) return "bsc";
  // TRC20 / 未知链：不假装能签，明确交给人工。
  return null;
}

/** ERC20 transfer(address,uint256) 的 calldata。 */
function erc20TransferData(token: string, to: string, amountUnits: bigint): string {
  const iface = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  return iface.encodeFunctionData("transfer", [token, amountUnits]);
}

export interface SendUsdtInput {
  chainId: "polygon" | "bsc";
  to: string;
  /** 收银台原样金额，如 "2.498"。 */
  amountUsdt: string;
  privateKey: string;
  /** 用户自配节点优先，公共节点兜底 —— 与收款扫链同一份列表。 */
  rpcUrls: string[];
}

export interface SendUsdtResult {
  txHash: string;
  /** 实际发出的最小单位金额（对账用）。 */
  amountUnits: string;
}

async function rpc<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as { result?: T; error?: { message: string } };
      if (payload.error) throw new Error(payload.error.message);
      if (payload.result === undefined) throw new Error("空响应");
      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`RPC ${method} 全部失败：${lastError instanceof Error ? lastError.message : lastError}`);
}

/**
 * 把精确金额的 USDT 从热钱包转给上游。
 *
 * gas 参数刻意保守：EIP-1559，priority fee 用链上建议值，gas limit 在
 * USDT transfer 的 5 万标准上留 20% 余量 —— 上游地址可能是合约，
 * 估太死会 revert，多估只多花几分钱的 gas 上限（未用部分退还）。
 */
export async function sendUsdt(input: SendUsdtInput): Promise<SendUsdtResult> {
  const spec = CHAIN_SPECS[input.chainId];
  if (!spec || spec.chainId === null) {
    throw new Error(`链 ${input.chainId} 不支持自动出款`);
  }
  const rpcUrls = input.rpcUrls.length > 0 ? input.rpcUrls : spec.rpcUrls;

  const provider = new JsonRpcProvider(rpcUrls[0], spec.chainId, {
    staticNetwork: true,
  });
  const wallet = new Wallet(input.privateKey, provider);
  const token = spec.token;
  const amountUnits = parseUnits(input.amountUsdt, spec.decimals);

  const [nonce, feeData] = await Promise.all([
    provider.getTransactionCount(wallet.address, "pending"),
    provider.getFeeData(),
  ]);
  if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) {
    throw new Error("无法获取 gas 费率，跳过本次出款");
  }

  const tx = await wallet.signTransaction({
    to: token,
    data: erc20TransferData(token, input.to, amountUnits),
    nonce,
    gasLimit: 60_000n,
    type: 2,
    chainId: spec.chainId,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  });

  const txHash = await rpc<string>(rpcUrls, "eth_sendRawTransaction", [tx]);
  return { txHash, amountUnits: amountUnits.toString() };
}
