/**
 * 品牌位图资产生成 —— 本地跑一次，产物提交进仓库。
 *
 *   pnpm tsx scripts/generate-brand-assets.ts
 *
 * 为什么不放进构建：sharp 是本地原生依赖，Workers 上没有；产物是确定性的
 * （同一份脚本永远产出同一张图），提交进 public/ 即可，部署无需重跑。
 * 底图 public/og-background.png 由 codex 按固定规格生成（见
 * docs/image-prompts.md 的 Prompt A），文字与 mark 由这里用代码排 ——
 * AI 负责氛围，代码负责排版，品牌字永远不会被 AI 写错。
 */

import { mkdir, writeFile } from "node:fs/promises";

import sharp from "sharp";

const W = 1200;
const H = 630;
const GREEN = "#1C5F45";
const CREAM = "#F7F5F2";

/** 与 src/app/icon.svg 同几何的 mark，按尺寸缩放绘制。 */
function markSvg(x: number, y: number, size: number): string {
  // 32 坐标系 → 目标尺寸。描边宽度按比例缩放，保持视觉重量一致。
  const s = size / 32;
  const stroke = 2.6 * s;
  return `
  <g transform="translate(${x}, ${y})">
    <rect width="${size}" height="${size}" rx="${7 * s}" fill="${GREEN}"/>
    <path d="M${18.2 * s} ${4 * s} L${10 * s} ${17 * s} H${15.2 * s} L${13.6 * s} ${22.5 * s} L${22.2 * s} ${11.5 * s} H${16.6 * s} Z"
      fill="${CREAM}"/>
    <path d="M${9.5 * s} ${25.5 * s} H${22.5 * s}"
      fill="none" stroke="${CREAM}" stroke-width="${stroke}" stroke-linecap="round"/>
  </g>`;
}

async function generateOgCard(): Promise<void> {
  // 底图缺失时退到纯米白，脚本永远可跑（刚 clone 就能出完整卡片）。
  const base = await sharp("public/og-background.png")
    .resize(W, H, { fit: "cover" })
    .png()
    .toBuffer()
    .catch(() => sharp({ create: { width: W, height: H, channels: 3, background: CREAM } }).png().toBuffer());

  const overlay = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .wordmark { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-weight: 700; font-size: 88px; letter-spacing: -2px;
                    fill: #191919; }
        .tagline  { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-weight: 400; font-size: 30px; letter-spacing: 0;
                    fill: #4a4a4a; }
        .meta     { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-weight: 500; font-size: 24px; letter-spacing: 3px;
                    fill: #1C5F45; }
      </style>
      ${markSvg(96, 140, 64)}
      <text class="wordmark" x="96" y="330">AICHONGZHAN</text>
      <text class="tagline" x="96" y="396">AI accounts &amp; codes, delivered automatically.</text>
      <text class="meta" x="96" y="500">USDT · POLYGON · BSC</text>
    </svg>`);

  await mkdir("public", { recursive: true });
  await sharp(base)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toFile("public/og-default.png");

  console.log("[brand] public/og-default.png 生成完成");
}

/** favicon 的 180px apple-touch 版本（iOS 主屏用，SVG icon 不被 Safari 识别）。 */
async function generateAppleTouchIcon(): Promise<void> {
  const icon = Buffer.from(`
    <svg width="180" height="180" xmlns="http://www.w3.org/2000/svg">
      ${markSvg(0, 0, 180).replace('rx="7"', 'rx="40"')}
    </svg>`);
  await sharp(icon).png().toFile("public/apple-touch-icon.png");
  console.log("[brand] public/apple-touch-icon.png 生成完成");
}

async function main(): Promise<void> {
  await generateOgCard();
  await generateAppleTouchIcon();
}

main().catch((error) => {
  console.error("[brand] 生成失败：", error);
  process.exit(1);
});
