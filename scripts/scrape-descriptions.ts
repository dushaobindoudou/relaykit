/**
 * 商品详情富文本抓取：上游 item 页的 .tokyo-description-body →
 * sanitizeDescription 白名单清洗 → 生成 UPDATE SQL。
 *
 * 用法：pnpm tsx scripts/scrape-descriptions.ts [out.sql]
 * 产物默认 /tmp/descriptions.sql，然后：
 *   sqlite3 <local-d1> < /tmp/descriptions.sql            （本地）
 *   npx wrangler d1 execute relaykit --remote --file ...  （线上）
 *
 * 说明：cron 同步（15 分钟）只覆盖 description 摘要列，不碰
 * description_html —— 本脚本是一次性/手动回填工具。
 */

import { writeFile } from "node:fs/promises";

import { sanitizeDescription } from "../src/catalog/sanitize";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BASE = "https://zhanghao66.com";

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": UA } });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

/** 提取 .tokyo-description-body 的内 HTML（body 是该 section 的最后一个 div）。 */
function extractDescription(html: string): string | null {
  const marker = 'tokyo-description-body">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const sectionEnd = html.indexOf("</section>", from);
  if (sectionEnd === -1) return null;
  const inner = html.slice(from, html.lastIndexOf("</div>", sectionEnd));
  return inner.trim() || null;
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? "/tmp/descriptions.sql";

  // 1. 商品 id 列表（分页拉全）
  const ids: number[] = [];
  for (let page = 1; ; page += 1) {
    const payload = JSON.parse(
      await fetchText(`${BASE}/user/api/index/commodity?limit=200&page=${page}`),
    ) as { data: Array<{ id: number }> };
    ids.push(...payload.data.map((item) => item.id));
    if (payload.data.length < 200) break;
  }
  console.log(`[scrape] 商品 ${ids.length} 个`);

  // 2. 逐个抓详情页 → 提取 → 清洗
  const updates: string[] = [];
  let scraped = 0;
  let empty = 0;
  for (const id of ids) {
    try {
      const html = await fetchText(`${BASE}/item/${id}`);
      const raw = extractDescription(html);
      const clean = raw ? sanitizeDescription(raw) : "";
      if (clean) {
        scraped += 1;
        updates.push(
          `UPDATE products SET description_html = '${sqlQuote(clean)}' WHERE supplier_id = 'upstream' AND code = '${id}';`,
        );
      } else {
        empty += 1;
      }
    } catch (error) {
      console.warn(`[scrape] item/${id} 失败：${error instanceof Error ? error.message : error}`);
      empty += 1;
    }
    // 温柔一点：不触发对方的频率防御
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  await writeFile(out, `${updates.join("\n")}\n`, "utf-8");
  console.log(`[scrape] 成功 ${scraped}，空/失败 ${empty} → ${out}`);
  console.log(`[scrape] 应用：sqlite3 <local-db> < ${out} ；线上 npx wrangler d1 execute relaykit --remote --file ${out} -y`);
}

await main();
