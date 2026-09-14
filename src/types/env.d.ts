/**
 * 密钥绑定声明。
 *
 * `wrangler types` 只能从 wrangler.jsonc 推出 vars 与资源绑定，
 * 通过 `wrangler secret put` 注入的密钥它看不见。在这里补上，
 * 顺便让这个文件成为「这个项目需要哪些密钥」的唯一权威清单。
 *
 * 这是对全局 `CloudflareEnv` 的声明合并（cloudflare-env.d.ts 里声明的
 * 就是这个全局接口，而不是 Cloudflare.Env 命名空间下的那个），
 * 所以本文件必须保持为全局脚本 —— 一旦加了顶层 import/export 就变成模块，
 * 合并会失效。
 */
interface CloudflareEnv {
  /** 管理端点鉴权（/api/admin/*）。未设置时管理端点一律拒绝服务。 */
  ADMIN_TOKEN?: string;

  /** 上游凭据。driver 为 acgfaka 时必填，由 daichong.config.yaml 用 ${} 引用。 */
  SUPPLIER_APP_ID?: string;
  SUPPLIER_APP_KEY?: string;

  /** 收款地址。钱的去处，部署前务必核对。 */
  POLYGON_ADDRESS?: string;
  BSC_ADDRESS?: string;
  TRON_ADDRESS?: string;

  /** 告警通道（可选）。 */
  ALERT_WEBHOOK_URL?: string;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
}
