/**
 * 链上收款监听。
 *
 * Workers 没有常驻进程，所以这不是一个长跑的监听器，而是**每次 Cron 触发
 * 时从游标处补扫一段区块**。设计上必须满足三件事：
 *
 *   1. 幂等。同一笔转账会被重复看到（重扫、Cron 重叠、节点回放），
 *      靠 seen_transfers 的唯一索引去重，绝不能重复入账。
 *   2. 不遗漏。游标必须持久化，且**只有整段扫完才前移** ——
 *      中途失败就下次重扫，宁可重复（有去重兜底）也不能跳过。
 *   3. 只认足够深的区块。未达确认数的区块可能被重组，此时入账等于
 *      发货给一笔会消失的付款。
 */

import { and, eq, sql } from "drizzle-orm";

import { creditTopup, getTopup } from "@/accounts/topup";
import {
  CHAIN_SPECS,
  TRANSFER_TOPIC,
  fromRawAmount,
  topicToAddress,
  toRawAmount,
} from "@/payments/chains";
import { chainCursors, orders, seenTransfers, topups } from "@/db/schema";
import { markPaid } from "@/orders/service";
import type { ChainConfig } from "@/config/schema";
import type { RelayKitContext } from "@/runtime/context";

export interface WatchReport {
  chainId: string;
  scannedFrom: number;
  scannedTo: number;
  transfers: number;
  matchedOrders: number;
  matchedTopups: number;
  unmatched: number;
  error?: string;
}

interface Transfer {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  to: string;
  raw: bigint;
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);

  const payload = (await response.json()) as { result?: T; error?: { message: string } };
  if (payload.error) throw new Error(`RPC ${method}: ${payload.error.message}`);
  if (payload.result === undefined) throw new Error(`RPC ${method}: empty result`);

  return payload.result;
}

/** 拉一段区块里打到我们地址的 USDT 转账。 */
async function fetchTransfers(
  rpcUrl: string,
  token: string,
  toAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Transfer[]> {
  const logs = await rpc<
    { transactionHash: string; logIndex: string; blockNumber: string; topics: string[]; data: string }[]
  >(rpcUrl, "eth_getLogs", [
    {
      address: token,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      // topics[2] 是收款方。让节点侧过滤，避免把整条链的转账拉回来。
      topics: [
        TRANSFER_TOPIC,
        null,
        `0x${toAddress.slice(2).toLowerCase().padStart(64, "0")}`,
      ],
    },
  ]);

  return logs.map((log) => ({
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
    blockNumber: Number(log.blockNumber),
    to: topicToAddress(log.topics[2] ?? ""),
    // data 是 32 字节的 uint256。用 BigInt 解，绝不用 Number。
    raw: BigInt(log.data),
  }));
}

/**
 * 处理一笔到账：按金额精确匹配待付订单或充值单。
 *
 * 匹配用的是**打标后的唯一金额**，所以一笔转账最多命中一个订单。
 * 命中不了的记为 unmatched 留给人工 —— 可能是客户转了整数、
 * 转错金额，或是有人主动往我们地址打款。
 */
async function settle(
  context: RelayKitContext,
  chainId: string,
  transfer: Transfer,
  amount: string,
): Promise<"order" | "topup" | "none"> {
  const pendingOrder = await context.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.chainId, chainId),
        eq(orders.payAmount, amount),
        eq(orders.status, "awaiting_payment"),
      ),
    )
    .limit(1);

  if (pendingOrder[0]) {
    const result = await markPaid(context, pendingOrder[0], transfer.txHash, amount);
    return result.ok ? "order" : "none";
  }

  const pendingTopup = await context.db
    .select()
    .from(topups)
    .where(
      and(
        eq(topups.chainId, chainId),
        eq(topups.payAmount, amount),
        eq(topups.status, "awaiting_payment"),
      ),
    )
    .limit(1);

  if (pendingTopup[0]) {
    const topup = await getTopup(context, pendingTopup[0].id);
    if (topup) {
      const result = await creditTopup(context, topup, transfer.txHash);
      return result.ok ? "topup" : "none";
    }
  }

  return "none";
}

export async function watchChain(
  context: RelayKitContext,
  chain: ChainConfig,
): Promise<WatchReport> {
  const spec = CHAIN_SPECS[chain.id];
  const report: WatchReport = {
    chainId: chain.id,
    scannedFrom: 0,
    scannedTo: 0,
    transfers: 0,
    matchedOrders: 0,
    matchedTopups: 0,
    unmatched: 0,
  };

  if (!spec) return { ...report, error: `未知的链: ${chain.id}` };
  if (spec.chainId === null) {
    // Tron 不是 EVM，需要单独的实现。暂不支持，明确报错而不是静默跳过 ——
    // 静默跳过会让店主以为收款在正常工作。
    return { ...report, error: "Tron 的收款监听尚未实现" };
  }

  const rpcUrl = chain.rpcUrl ?? spec.rpcUrl;
  const token = chain.tokenAddress ?? spec.token;

  try {
    const head = Number(await rpc<string>(rpcUrl, "eth_blockNumber", []));
    // 只认已经埋够确认数的区块。更浅的区块可能被重组，此时入账
    // 等于对一笔会消失的付款发了货。
    const safeHead = head - chain.confirmations;
    if (safeHead <= 0) return report;

    const cursorRows = await context.db
      .select()
      .from(chainCursors)
      .where(eq(chainCursors.chainId, chain.id))
      .limit(1);

    // 首次运行不回溯整条链：从「一个支付窗口之前」开始就够了，
    // 更早的转账不可能对应任何还在等待的订单。
    const lookbackBlocks = Math.ceil(
      (context.config.payments.windowMinutes * 60) / spec.blockSeconds,
    );
    const from = cursorRows[0]
      ? cursorRows[0].lastScannedBlock + 1
      : Math.max(1, safeHead - lookbackBlocks);

    if (from > safeHead) return { ...report, scannedFrom: from, scannedTo: safeHead };

    // 公共节点对 eth_getLogs 的区块跨度有上限，分片拉取。
    // 每次 Cron 只推进有限片数，避免长时间落后时单次执行超时。
    const maxChunks = 5;
    let cursor = from;
    let processed = cursor - 1;

    for (let chunk = 0; chunk < maxChunks && cursor <= safeHead; chunk += 1) {
      const to = Math.min(cursor + spec.maxBlockRange - 1, safeHead);
      const transfers = await fetchTransfers(
        rpcUrl,
        token,
        chain.address,
        cursor,
        to,
      );

      for (const transfer of transfers) {
        report.transfers += 1;
        const amount = fromRawAmount(transfer.raw, spec.decimals);

        // 去重：唯一索引是 (链, txHash, logIndex)。插入失败说明这笔
        // 已经处理过，直接跳过 —— 这是幂等的关键。
        try {
          await context.db.insert(seenTransfers).values({
            chainId: chain.id,
            txHash: transfer.txHash,
            logIndex: transfer.logIndex,
            orderId: null,
            toAddress: transfer.to,
            amount,
            blockNumber: transfer.blockNumber,
            seenAt: new Date().toISOString(),
          });
        } catch {
          continue;
        }

        const outcome = await settle(context, chain.id, transfer, amount);
        if (outcome === "order") report.matchedOrders += 1;
        else if (outcome === "topup") report.matchedTopups += 1;
        else report.unmatched += 1;
      }

      processed = to;
      cursor = to + 1;
    }

    // 游标只在整段扫完后前移。中途抛错就不更新，下次从原处重扫 ——
    // 重复由去重兜底，遗漏则无法补救。
    await context.db
      .insert(chainCursors)
      .values({
        chainId: chain.id,
        lastScannedBlock: processed,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: chainCursors.chainId,
        set: { lastScannedBlock: processed, updatedAt: new Date().toISOString() },
      });

    report.scannedFrom = from;
    report.scannedTo = processed;
    return report;
  } catch (error) {
    return {
      ...report,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 扫描全部已启用且配置完整的链。 */
export async function watchAll(context: RelayKitContext): Promise<WatchReport[]> {
  const { payableChains } = await import("@/config/schema");
  const reports: WatchReport[] = [];

  // 串行：Cron 的执行时长有限，且公共 RPC 并发容易触发限流。
  for (const chain of payableChains(context.config)) {
    reports.push(await watchChain(context, chain));
  }

  return reports;
}

/** 供测试与排查使用：把金额换算暴露出来。 */
export { fromRawAmount, toRawAmount };

/** 未匹配到订单的入账，供后台人工排查。 */
export async function listUnmatched(context: RelayKitContext, limit = 50) {
  return context.db
    .select()
    .from(seenTransfers)
    .where(sql`${seenTransfers.orderId} is null`)
    .limit(limit);
}
