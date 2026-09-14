/**
 * 构建期把 daichong.config.yaml 编译成 TS 模块。
 *
 * 为什么不在运行期读文件：Cloudflare Workers 没有文件系统。把 YAML 预生成成
 * 一个普通模块，运行期 import 即可，Node 与 Workers 走完全相同的代码路径。
 *
 * 注意这里生成的是**未插值**的原始结构 —— ${ENV} 留在字符串里，等运行期
 * 由各自的 env 源展开。密钥因此不会被烘进产物。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

const CONFIG = process.env.DAICHONG_CONFIG ?? "daichong.config.yaml";
const FALLBACK = "daichong.config.example.yaml";
const OUT = "src/config/generated.ts";

const source = existsSync(CONFIG) ? CONFIG : FALLBACK;

if (source === FALLBACK) {
  // 不报错：让 `git clone && pnpm dev` 直接能跑起来（示例配置用的是 mock 上游）。
  console.warn(
    `[build-config] 未找到 ${CONFIG}，回退到 ${FALLBACK}（演示模式，mock 上游）`,
  );
}

const raw = parse(readFileSync(source, "utf8"));

writeFileSync(
  OUT,
  `// 由 scripts/build-config.mjs 自动生成，请勿手改。\n` +
    `// 来源：${source}\n` +
    `// 这里保留未插值的 \${ENV} 占位，密钥在运行期才展开，不会进入产物。\n` +
    `/* eslint-disable */\n` +
    `export const generatedRawConfig = ${JSON.stringify(raw, null, 2)} as const;\n`,
  "utf8",
);

console.log(`[build-config] ${source} → ${OUT}`);
