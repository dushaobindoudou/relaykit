import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workers 运行时没有 sharp，内建图片优化不可用；站点图片走 Cloudflare Images
  // 或直接用未优化的原图。
  images: { unoptimized: true },
};

export default nextConfig;
