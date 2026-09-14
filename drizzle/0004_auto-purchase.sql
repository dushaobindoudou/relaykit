-- 自动中转采购：订单上的上游侧字段。
-- 一个订单对应一张（可能凑单扩量的）上游游客订单。
ALTER TABLE orders ADD upstream_trade_no text;
ALTER TABLE orders ADD upstream_pay_address text;
ALTER TABLE orders ADD upstream_pay_amount text;
ALTER TABLE orders ADD upstream_pay_chain text;
ALTER TABLE orders ADD upstream_paid_tx_hash text;
ALTER TABLE orders ADD upstream_contact text;
ALTER TABLE orders ADD upstream_attempt integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `orders_upstream_procuring_idx` ON `orders` (`status`,`upstream_trade_no`);
