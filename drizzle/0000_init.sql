CREATE TABLE `chain_cursors` (
	`chain_id` text PRIMARY KEY NOT NULL,
	`last_scanned_block` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text,
	`accepted` integer NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`supplier_id` text NOT NULL,
	`product_code` text NOT NULL,
	`race` text DEFAULT '' NOT NULL,
	`product_name` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`price_total` text NOT NULL,
	`cost_snapshot` text NOT NULL,
	`fx_rate` text DEFAULT '1' NOT NULL,
	`currency` text NOT NULL,
	`request_no` text NOT NULL,
	`chain_id` text,
	`pay_address` text,
	`pay_amount` text,
	`pay_window_ends_at` text,
	`paid_tx_hash` text,
	`paid_amount` text,
	`paid_at` text,
	`supplier_trade_no` text,
	`secret` text,
	`leave_message` text,
	`review_reason` text,
	`contact_email` text,
	`query_password_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_request_no_unique` ON `orders` (`request_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_pay_amount_open_unique` ON `orders` (`chain_id`,`pay_amount`) WHERE status = 'awaiting_payment';--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_created_at_idx` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `orders_chain_amount_idx` ON `orders` (`chain_id`,`pay_amount`);--> statement-breakpoint
CREATE TABLE `products` (
	`supplier_id` text NOT NULL,
	`code` text NOT NULL,
	`race` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`cost` text NOT NULL,
	`price` text,
	`sellable` integer DEFAULT false NOT NULL,
	`unsellable_reason` text,
	`stock` integer DEFAULT 0 NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_pk` ON `products` (`supplier_id`,`code`,`race`);--> statement-breakpoint
CREATE INDEX `products_sellable_idx` ON `products` (`sellable`);--> statement-breakpoint
CREATE TABLE `seen_transfers` (
	`chain_id` text NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`order_id` text,
	`to_address` text NOT NULL,
	`amount` text NOT NULL,
	`block_number` integer NOT NULL,
	`seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seen_transfers_pk` ON `seen_transfers` (`chain_id`,`tx_hash`,`log_index`);--> statement-breakpoint
CREATE INDEX `seen_transfers_unmatched_idx` ON `seen_transfers` (`order_id`);