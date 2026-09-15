-- 通用站点设置（JSON 文档）：目前存人工收款渠道的运营态覆盖
-- （支付宝/微信收款码与账号，后台可改，无需重新部署）。
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
