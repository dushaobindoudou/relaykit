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

import { syncAll } from "@/catalog/sync";
import { buildContext, type Bindings } from "@/runtime/context";

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
    case EVERY_MINUTE:
      // 收款轮询将挂在这里。链上监听尚未接入，此处暂不做事 ——
      // 留空而不是删掉 cron，是为了让部署配置与最终形态保持一致。
      return;

    case EVERY_15_MINUTES: {
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
