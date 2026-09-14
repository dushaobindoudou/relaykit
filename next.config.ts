import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// dev 模式下注入 Cloudflare 绑定（D1 等）。没有这一行，任何调用
// getCloudflareContext() 的页面/路由在 next dev 里都会 500 ——
// 而 buildContext 依赖它拿 D1，等于整个站都打不开。
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  // Workers 运行时没有 sharp，内建图片优化不可用；站点图片走 Cloudflare Images
  // 或直接用未优化的原图。
  images: { unoptimized: true },
  // 构建期类型检查**刻意关闭**：worker/entry.ts（wrangler 的 main）import 的
  // `../.open-next/worker.js` 是 OpenNext 构建产物，而产物生成又是构建的
  // 第二步 —— 冷环境下 next build 永远过不了这道自引用。类型安全不靠
  // 这里兜底，靠两个必须显式跑的脚本：pnpm typecheck（src/）与
  // pnpm typecheck:worker（worker/，tsconfig.worker.json）。两者都绿才能部署。
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
