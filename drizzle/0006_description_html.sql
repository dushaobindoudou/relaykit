-- 商品详情页的富文本描述（从上游 item 页抓取，白名单清洗后入库）。
-- 与 description（API 的纯文本摘要）并存；cron 同步不覆盖本列。
ALTER TABLE `products` ADD COLUMN `description_html` text;
