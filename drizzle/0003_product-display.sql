-- 展示性与预订扩展：
-- 1. 上游累计销量（展示用，与本地订单数严格区分）。
-- 2. 订单的预订标记：创建时库存不足但商品可预订，付款后进 reserved 排队。
ALTER TABLE `products` ADD `sales_count` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `reservation` integer DEFAULT false NOT NULL;
