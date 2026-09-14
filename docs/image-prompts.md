# 品牌图片 Prompt 包（ChatGPT / Codex 通用）

这套提示词用于生成站点的**位图**品牌资产。矢量类（favicon、头部 mark）是
手写 SVG，不在包里；商品图来自上游截图，走 `scripts/sync-upstream.ts` 的
本地化管线，也不需要生成。

使用方式二选一：

1. **丢进 ChatGPT**（GPT-4o 生成图片），把产出的 PNG 存到指定路径，然后
   重跑 `pnpm tsx scripts/generate-brand-assets.ts` 合成；
2. **本机 codex 直接生成**（提示词原样可用，注意让它存到指定路径）：

   ```bash
   codex exec --sandbox workspace-write --skip-git-repo-check "<贴入提示词>"
   ```

---

## Prompt A — og 分享卡底图（`public/og-background.png`）

> Generate ONE image and save it as a 1200x630 PNG.
>
> A minimal, premium abstract background for a technology brand's social share
> card. Warm off-white paper background (#F7F5F2). In the right third, a
> large, quiet composition of overlapping flat geometric shapes (circle, arc,
> thin ring) in deep green (#1C5F45) with one soft sage-green (#E9F2EE) shape;
> very subtle, lots of empty space on the left two-thirds (that area must stay
> clean off-white because a title will be placed there later). Style: flat
> vector, print-quality, Swiss minimalism, Shopify editorial aesthetic.
> Absolutely NO text, NO letters, NO numbers, NO gradients heavier than
> subtle, NO photorealism.

存好后运行 `pnpm tsx scripts/generate-brand-assets.ts`，它会合成品牌字与
mark 输出 `public/og-default.png`。**文字永远由代码排**，所以底图不需要也
不应该带任何文字。

## Prompt B — 首页 Banner（可选，`public/hero-banner.png`，1600×900）

> Generate ONE image, 1600x900 PNG.
>
> A calm, wide hero image for a minimalist digital-goods storefront. Warm
> off-white (#F7F5F2) background with a barely-there paper grain. On the right
> half, a soft arrangement of three floating flat geometric cards in deep
> green (#1C5F45), sage (#E9F2EE) and warm grey (#EDEAE5), slightly overlapping,
> with generous soft shadows — evoking product cards. The left half stays
> almost empty (text will be overlaid). Flat vector style, Swiss typography
> aesthetic, premium and quiet. NO text, NO logos, NO people, NO photorealism.

接线方式（生成后手动加）：首页顶部加一个两栏 section，文字用现有 i18n，
图片右侧展示。**不做默认接入**——Dawn 的气质是文字主导，banner 可有可无，
先看图再决定。

## Prompt C — 帮助中心插画（3 张一组，`public/help-*.png`，各 800×500）

三张一起生成（在同一次对话里说 "in the same style, generate 3 images"），
保证风格一致：

> Generate ONE image, 800x500 PNG. A small flat spot illustration in a
> minimal Swiss editorial style: warm off-white background (#F7F5F2), line
> and shape work in deep green (#1C5F45) with sage (#E9F2EE) accents,
> generous margins, no text.
>
> 1. `help-pay.png` — a hand placing a coin into a minimal wallet slot
>    (payment theme)
> 2. `help-deliver.png` — an open box with a single glowing key rising out of
>    it (instant delivery theme)
> 3. `help-safe.png` — a shield with a checkmark, geometric and calm
>    (buyer-protection theme)

NO letters, NO numbers, NO photorealism in all three.

## Prompt D — 商品占位图（`public/product-placeholder.png`，800×800）

商品没有封面时的兜底（当前是首字母占位，换成图更精致）：

> Generate ONE image, 800x800 PNG. A minimal product placeholder tile for a
> premium storefront: warm off-white (#F7F5F2) background, centered abstract
> box outline in deep green (#1C5F45) with a small sage (#E9F2EE) circle
> behind it, flat vector, very quiet and generic, NO text, NO letters.

---

## 验收清单（每张图都要过）

- [ ] `file public/xxx.png` 尺寸正确
- [ ] 主色只有 #F7F5F2 / #1C5F45 / #E9F2EE 三色族（可用 sharp stats 抽查）
- [ ] 图内**没有文字**（文字一律代码排）
- [ ] og 底图左 2/3 保持大面积米白（文字落点）
