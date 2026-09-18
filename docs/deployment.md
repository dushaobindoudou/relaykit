# 部署指南

代充 的目标部署环境是 **Cloudflare Workers + D1 + Cron Triggers**，
全部在免费额度内可用：没有服务器、没有容器、没有需要照看的数据库。

它同时也是一个标准的 Next.js 应用，可以部署到任何 Node 宿主 —— 见文末。

---

## 一、一键部署（推荐初次尝试）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dushaobindoudou/buyrelay)

点击后 Cloudflare 会：

1. 把仓库 fork 到你的 GitHub
2. 自动置备 D1 数据库（读 `wrangler.jsonc` 的声明）
3. 逐项提示填写 `.dev.vars.example` 里声明的密钥
4. 构建并部署

完成后站点跑的是**演示配置**（`mock` 上游、假商品）。要接真实上游，
在你 fork 的仓库里编辑 `buyrelay.config.yaml` 然后推送即可，
Cloudflare 会自动重新部署。

> 一键部署会自动置备 D1，但 `wrangler.jsonc` 里的 `database_id` 是本仓库
> 自己那个实例的值。手动部署时**必须**替换成你自己的，见下一节。

---

## 二、手动部署

### 前置

- Node ≥ 20.11、pnpm
- 一个 Cloudflare 账号（免费即可）

```bash
git clone https://github.com/dushaobindoudou/buyrelay
cd relaykit
pnpm install
npx wrangler login
```

### 1. 创建数据库

```bash
npx wrangler d1 create relaykit
```

把输出里的 `database_id` 填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "relaykit",
    "database_id": "你刚拿到的 id",   // ← 替换这里
    "migrations_dir": "drizzle"
  }
]
```

### 2. 建表

```bash
npx wrangler d1 migrations apply relaykit --remote
```

本地开发库同理，去掉 `--remote`。

### 3. 配置密钥

```bash
# 管理端点鉴权。不设置的话 /api/admin/* 一律拒绝服务。
openssl rand -hex 24 | npx wrangler secret put ADMIN_TOKEN

# 收款地址 —— 钱的去处，逐字核对
npx wrangler secret put POLYGON_ADDRESS

# 上游凭据（driver 为 acgfaka 时）
npx wrangler secret put SUPPLIER_APP_ID
npx wrangler secret put SUPPLIER_APP_KEY
```

完整清单见 `.dev.vars.example`。

### 4. 写配置

```bash
cp buyrelay.config.example.yaml buyrelay.config.yaml
```

按 [配置参考](./configuration.md) 修改。**注意 `buyrelay.config.yaml` 在
`.gitignore` 里** —— 它是你的店铺配置，示例文件才是仓库里那份。

如果你 fork 之后想把自己的配置提交进去（这是支持的，密钥都是 `${}` 引用），
把它从 `.gitignore` 里去掉即可。

### 5. 部署

```bash
pnpm deploy
```

### 6. 验证

```bash
curl https://<你的域名>/api/health
```

期望看到 `config` / `database` / `fx` / `payments:*` / `supplier:*` 全绿。
任何一项标红，`detail` 里会写明该去改什么。

### 7. 同步商品

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<你的域名>/api/admin/sync
```

之后每 15 分钟自动同步一次。

---

## 三、本地开发

```bash
pnpm dev          # Next.js 开发服务器，最快的反馈循环
pnpm preview      # 在真实的 Workers 运行时里跑，部署前的最后一道验证
```

两者的区别值得注意：`pnpm dev` 跑在 Node 上，`pnpm preview` 跑在 workerd 上。
**有些问题只会在后者暴露**（缺失的 `node:` 模块、不可用的全局对象），
所以正式部署前至少 preview 一次。

本地密钥放 `.dev.vars`（从 `.dev.vars.example` 复制），
`wrangler dev` 与 `preview` 会自动加载。

---

## 四、定时任务

`wrangler.jsonc` 里声明了两条 Cron：

| 表达式 | 任务 |
|---|---|
| `* * * * *` | 链上收款轮询（**尚未实现**，见 README 的项目状态） |
| `*/15 * * * *` | 商品目录同步 |

Workers 没有常驻进程，所有后台工作都必须挂在 Cron 上。入口在
`worker/entry.ts` 的 `scheduled` —— 它包在 OpenNext 生成的 worker 外面，
因为后者只有 `fetch`。

改 Cron 频率就改 `wrangler.jsonc` 的 `triggers.crons`，然后重新部署。

查看执行记录：Cloudflare 控制台 → Workers → relaykit → Logs（已开启
`observability`）。

---

## 五、自定义域名

```bash
npx wrangler deploy --routes "shop.example.com/*"
```

或在控制台里 Workers → relaykit → Settings → Domains & Routes 绑定。

绑好之后记得把 `buyrelay.config.yaml` 的 `store.baseUrl` 改成新域名并重新
部署 —— 订单页的绝对链接和 SEO canonical 都取自它。

---

## 六、更新

```bash
git pull
pnpm install
npx wrangler d1 migrations apply relaykit --remote   # 有新迁移时
pnpm deploy
```

---

## 七、部署到 Cloudflare 以外

代充 是标准 Next.js 应用，`pnpm build && pnpm start` 可以跑在任何 Node
宿主上。但有两处要自己替换：

1. **数据库**：`src/runtime/context.ts` 里用的是 `drizzle-orm/d1`。
   换成 `better-sqlite3`、`postgres-js` 等其它 Drizzle 驱动即可，
   表结构（`src/db/schema.ts`）是通用 SQLite/SQL，不含 D1 专有特性。
2. **定时任务**：`worker/entry.ts` 的 `scheduled` 换成 systemd timer、
   cron、或任何调度器，调用同样的函数。

---

## 排错

### `/api/health` 报「配置引用了未设置的环境变量」

密钥没设。报错信息会指明是配置里的哪个字段引用了它。

### 改了配置但线上没变化

配置在**构建期**编译进产物（Workers 上没有文件系统），必须重新 `pnpm deploy`。

如果部署了仍是旧值，清一下构建缓存：

```bash
rm -rf .next .open-next && pnpm deploy
```

### 部署报 `binding refers to a class that does not exist`

`worker/entry.ts` 少透传了 OpenNext 的某个 Durable Object。它必须原样
re-export `DOQueueHandler`、`DOShardedTagCache`、`BucketCachePurge` 三个。

### `The entry-point file was not found`

`wrangler.jsonc` 的 `main` 指向了错误的路径。应当是 `worker/entry.ts`。

### 商品同步后目录仍为空

看 `/api/admin/sync` 的返回，`reasons` 字段会说明每个商品为什么没上架：

| 原因 | 含义 |
|---|---|
| `上游未返回该规格的拿货价` | 上游没为该商品开启「开放对接」 |
| `margin_too_low` | 毛利低于 `minMarginPercent`，调整加价或下限 |
| `stale_rate` | 汇率过期，更新 `pricing.fx` |
| `missing_rate` | 缺上游结算币到展示币的汇率 |
| `上游缺货` | 上游库存为 0 |
