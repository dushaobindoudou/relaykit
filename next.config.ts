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
};

export default nextConfig;
