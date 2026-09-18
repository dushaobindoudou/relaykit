/**
 * Worker 入口。
 *
 * OpenNext 生成的 `.open-next/worker.js` 只有 `fetch`，而 Workers 上没有
 * 常驻进程 —— 商品同步、余额巡检、收款轮询这些后台活儿只能挂在 Cron 上，
 * 而 Cron 触发的是 `scheduled` 而不是 `fetch`。所以在它外面包一层。
 *
 * 三个 Durable Object 必须原样透传：OpenNext 用它们做增量缓存与队列，
 * 漏掉任何一个，部署会以 "binding refers to a class that does not exist"
 * 失败。
 *
 * 这个文件刻意放在 src/ 之外：它 import 的 `.open-next/worker.js` 是
 * `next build` **之后**才生成的产物，而 Next 会在 build 期间类型检查 src/ ——
 * 放在里面就成了先有鸡还是先有蛋。它由 tsconfig.worker.json 单独检查，
 * 见 package.json 的 typecheck:worker。
 */

import openNextHandler from "../.open-next/worker.js";

import { expireStaleTopups } from "@/accounts/topup";
import { syncAll } from "@/catalog/sync";
import { expireStaleOrders, fulfillOrder } from "@/orders/service";
import { settleUpstreamPurchases } from "@/orders/auto-purchase";
import { watchAll } from "@/payments/watcher";
import { refreshFx } from "@/pricing/fx";
import { orders } from "@/db/schema";
import { buildContext, type Bindings, type BuyRelayContext } from "@/runtime/context";
import { eq } from "drizzle-orm";

export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "../.open-next/worker.js";

/**
 * Cron 表达式 → 任务。
 *
 * wrangler.jsonc 里配了几条 cron，这里就要能区分它们 —— 否则每分钟的
 * 收款轮询会顺带把商品目录也同步一遍，白白打爆上游的接口。
 */
const EVERY_MINUTE = "* * * * *";
const EVERY_15_MINUTES = "*/15 * * * *";

async function runScheduled(cron: string, env: Bindings): Promise<void> {
  const result = buildContext(env);
  if (!result.ok || !result.context) {
    // 配置坏了就别静默重试 —— 打日志，让 observability 里看得见。
    console.error("[cron] 配置无效，跳过本次执行:", result.error);
    return;
  }

  const context = result.context;

  switch (cron) {
    case EVERY_MINUTE: {
      // 顺序是有讲究的：先收款、再发货、最后清理过期单。
      // 反过来的话，刚到账还没来得及标记 paid 的订单会被超时任务作废。
      for (const report of await watchAll(context)) {
        if (report.error) {
          console.error(`[cron] 扫链 ${report.chainId} 失败: ${report.error}`);
        } else if (report.transfers > 0) {
          console.log(
            `[cron] 扫链 ${report.chainId} ${report.scannedFrom}-${report.scannedTo}: ` +
              `${report.transfers} 笔到账，命中订单 ${report.matchedOrders}、` +
              `充值 ${report.matchedTopups}、未匹配 ${report.unmatched}`,
          );
        }
      }

      await fulfillPaidOrders(context);

      // 自动中转采购的下半场：付款/轮询/收卡。放在发货之后，
      // 刚下上游单的订单下一分钟就开始被推进。
      const settled = await settleUpstreamPurchases(context);
      if (settled.delivered > 0 || settled.flagged > 0) {
        console.log(
          `[cron] 自动采购推进 ${settled.handled} 单：交付 ${settled.delivered}、转人工 ${settled.flagged}`,
        );
      }

      const expired = await expireStaleOrders(context);
      const expiredTopups = await expireStaleTopups(context);
      if (expired || expiredTopups) {
        console.log(`[cron] 过期关闭：订单 ${expired}、充值单 ${expiredTopups}`);
      }
      return;
    }

    case EVERY_15_MINUTES: {
      // 汇率先行：同步流程里定价要用它，陈旧会整站下架。
      // 动态汇率是显式的配置选择（source: coingecko）；静态配置自己管理时效。
      if (context.config.pricing.fx.source === "coingecko") {
        try {
        const fx = await refreshFx(context.db);
        console.log(`[cron] 汇率刷新 CNY_USDT=${fx.rate}（${fx.source}）`);
        } catch (error) {
          console.error(`[cron] 汇率刷新失败: ${error instanceof Error ? error.message : error}`);
        }
      }

      const reports = await syncAll(context);
      for (const report of reports) {
        if (report.error) {
          console.error(`[cron] 同步 ${report.supplierId} 失败: ${report.error}`);
        } else {
          console.log(
            `[cron] 同步 ${report.supplierId}: 上架 ${report.listed}，` +
              `下架 ${report.withheld} ${JSON.stringify(report.reasons)}`,
          );
        }
      }
      return;
    }

    default:
      console.warn(`[cron] 未识别的表达式: ${cron}`);
  }
}

/**
 * 把已付款的订单推去进货发货。
 *
 * 逐单串行：进货是花钱的操作，并发下即便有状态机与幂等键兜底，
 * 也没有理由为了几百毫秒去冒这个险。单次最多处理 20 张，
 * 剩下的留给下一分钟 —— Cron 的执行时长有限。
 */
async function fulfillPaidOrders(context: BuyRelayContext): Promise<void> {
  if (context.config.fulfillment.mode !== "auto") return;

  const pending = await context.db
    .select()
    .from(orders)
    .where(eq(orders.status, "paid"))
    .limit(20);

  for (const order of pending) {
    const result = await fulfillOrder(context, order);
    if (!result.ok) {
      console.error(`[cron] 订单 ${order.id} 发货失败(${result.status}): ${result.message}`);
    }
  }
}

export default {
  fetch: openNextHandler.fetch,

  async scheduled(
    controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    // waitUntil 而非直接 await：Cron 的执行有墙钟上限，把工作挂到 ctx 上
    // 可以在超时前让运行时知道还有未完成的任务。
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Bindings>;
