CREATE TABLE `categories` (
	`supplier_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`parent_id` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`sellable_count` integer DEFAULT 0 NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_pk` ON `categories` (`supplier_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `categories_sort_idx` ON `categories` (`sort`);--> statement-breakpoint
ALTER TABLE `products` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `products` ADD `cover` text;--> statement-breakpoint
ALTER TABLE `products` ADD `delivery_way` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `stock_text` text;--> statement-breakpoint
ALTER TABLE `products` ADD `description` text;--> statement-breakpoint
ALTER TABLE `products` ADD `tags` text;--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`,`sellable`);