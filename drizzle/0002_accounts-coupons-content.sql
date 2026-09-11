CREATE TABLE `announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`banner_text` text,
	`active` integer DEFAULT true NOT NULL,
	`popup` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `announcements_active_idx` ON `announcements` (`active`,`sort`);--> statement-breakpoint
CREATE TABLE `articles` (
	`slug` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body` text NOT NULL,
	`published` integer DEFAULT true NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `articles_published_idx` ON `articles` (`published`,`sort`);--> statement-breakpoint
CREATE TABLE `balance_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` text NOT NULL,
	`balance_after` text NOT NULL,
	`order_id` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `balance_tx_user_idx` ON `balance_transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `coupon_redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`order_id` text NOT NULL,
	`identity` text NOT NULL,
	`discount` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_redemptions_order_unique` ON `coupon_redemptions` (`order_id`);--> statement-breakpoint
CREATE INDEX `coupon_redemptions_identity_idx` ON `coupon_redemptions` (`code`,`identity`);--> statement-breakpoint
CREATE TABLE `coupons` (
	`code` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`min_amount` text DEFAULT '0' NOT NULL,
	`usage_limit` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`per_user_limit` integer,
	`product_code` text,
	`expires_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coupons_active_idx` ON `coupons` (`active`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `topups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'awaiting_payment' NOT NULL,
	`amount` text NOT NULL,
	`chain_id` text NOT NULL,
	`pay_address` text NOT NULL,
	`pay_amount` text NOT NULL,
	`pay_window_ends_at` text NOT NULL,
	`paid_tx_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topups_pay_amount_open_unique` ON `topups` (`chain_id`,`pay_amount`) WHERE status = 'awaiting_payment';--> statement-breakpoint
CREATE INDEX `topups_user_idx` ON `topups` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`balance` text DEFAULT '0' NOT NULL,
	`total_spent` text DEFAULT '0' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `orders` ADD `coupon_code` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `discount` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `pay_method` text DEFAULT 'chain' NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_contact_idx` ON `orders` (`contact_email`);--> statement-breakpoint
ALTER TABLE `products` ADD `wholesale_tiers` text;--> statement-breakpoint
ALTER TABLE `products` ADD `reservable` integer DEFAULT false NOT NULL;