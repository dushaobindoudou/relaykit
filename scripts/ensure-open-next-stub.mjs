/**
 * 部署自举：确保 .open-next/worker.js 存在。
 *
 * worker/entry.ts import 的 `../.open-next/worker.js` 是 OpenNext 构建的
 * **产物**，而它的构建流程又以 `next build` 为第一步 —— 冷环境（首次部署、
 * 清理过产物）下 next build 的类型检查会因找不到这个模块直接失败，鸡生蛋。
 *
 * 解法：在 opennextjs-cloudflare build 之前放一个一次性 stub（allowJs 下
 * 类型可解析）。真实构建随后会在同一路径生成真正的 worker.js 并覆盖它，
 * stub 只服务于「让第一次类型检查通过」。
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const STUB = "export default { fetch: () => new Response(null, { status: 500 }) };\n";

mkdirSync(".open-next", { recursive: true });
if (!existsSync(".open-next/worker.js")) {
  writeFileSync(".open-next/worker.js", STUB);
  console.log("[ensure-open-next-stub] 已写入一次性 stub .open-next/worker.js");
} else {
  console.log("[ensure-open-next-stub] .open-next/worker.js 已存在，跳过");
}
