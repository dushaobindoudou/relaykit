# RelayKit

**一套可自托管的数字商品转售店面。** 接上任意上游供货商，设定加价，收加密货币，
自动发货。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dushaobindoudou/relaykit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.md) · [配置参考](./docs/configuration.md) · [部署指南](./docs/deployment.md)

---

## 这是什么

你有一个数字商品的货源 —— 软件授权、订阅兑换码、礼品卡、充值码 —— 想用自己的
品牌、自己的币种、卖给自己的客户。RelayKit 就是这两件事之间的那套机器：

```
 客户 ──▶ 你的店面 ──────▶ 上游供货商
          │                  │
          │ 加密货币结账      │ 代你下真实订单
          │ 你的加价          │ 返回卡密
          ▼                  ▼
      订单状态机 ─────────▶ 已交付
```

一份 YAML 配完，开店不用改代码。

**它不是**支付处理商、担保平台，也不提供货源。上游关系和收款钱包由你自己准备。

## 为什么用它

- **不绑定上游。** 业务代码只面向 `SupplierAdapter` 接口，从不接触某一家的
  协议细节。换上游 = 新增一个实现文件，店面、结账、订单状态机、发货一行不动。
- **钱的安全性由结构保证。** 金额全程是十进制字符串，绝不退化成浮点。成本缺失
  或汇率过期时定价引擎直接拒绝报价。订单状态机让「已付款的订单被作废」和
  「向上游重复下单」在结构上不可能发生，两条都用穷举测试钉死。
- **跑在 Cloudflare 免费额度上。** Workers + D1 + Cron Triggers，没有服务器、
  没有容器、没有要照看的数据库。
- **零凭据即可启动。** 内置 mock 上游，`git clone && pnpm dev` 就是一个能点、
  能下单、有真实定价的店 —— 谈上游之前就能先看到成品。

## 快速开始

```bash
git clone https://github.com/dushaobindoudou/relaykit
cd relaykit
pnpm install
pnpm dev
```

跑的是内置演示上游：真实定价、真实订单记录、假的货。
打开 http://localhost:3000 看店面，http://localhost:3000/api/health 看配置诊断。

接真实上游就复制示例配置改：

```bash
cp relaykit.config.example.yaml relaykit.config.yaml
```

## 配置

全部在 `relaykit.config.yaml` 里。**结构进文件，密钥进环境变量** —— 任何字符串
都支持 `${VAR}` 引用，所以这份配置文件可以放心提交进仓库、可以直接贴进 issue 求助。

```yaml
store:
  name: "My Digital Store"
  currency: USDT
  baseUrl: "https://shop.example.com"

suppliers:
  - id: primary
    driver: acgfaka                       # 或 mock（内置演示上游）
    domain: "https://upstream.example.com"
    appId: "${SUPPLIER_APP_ID}"
    appKey: "${SUPPLIER_APP_KEY}"
    currency: CNY

pricing:
  fx:
    source: static
    rates: { CNY_USDT: "0.1389" }         # 1 CNY = 0.1389 USDT
    updatedAt: "2026-09-11T00:00:00Z"
  markup:
    type: fixed                           # fixed | percent
    amount: "1"                           # 每单赚 1 USDT
  minMarginPercent: 5                     # 低于此毛利率自动下架
  maxStalenessHours: 24                   # 汇率过期即停售

payments:
  windowMinutes: 30
  chains:
    - id: polygon
      address: "${POLYGON_ADDRESS}"
      confirmations: 30

fulfillment:
  mode: auto                              # auto | manual
  balanceAlertThreshold: "200"
```

三个字段直接决定你赚还是赔，它们**没有安全默认值**，必须自己想清楚：

| 配置项 | 配错的后果 |
|---|---|
| `pricing.fx.rates` | 每个价格都按你的误差幅度错 |
| `pricing.markup` | 固定加价的毛利率随客单价上升而下降：同样加 1 USDT，2.5 USDT 的货是 28% 毛利，16 USDT 的货只有 5.9% |
| `pricing.minMarginPercent` | 设成 0，上游一涨价你就在成本线下卖货 |

完整说明见 **[docs/configuration.md](./docs/configuration.md)**。

## 部署

### Cloudflare 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dushaobindoudou/relaykit)

自动置备 D1 数据库、逐项提示填写 `.dev.vars.example` 里声明的密钥、构建并部署。
之后在你 fork 的仓库里改 `relaykit.config.yaml` 推送即可。

### Cloudflare 手动部署

```bash
pnpm install
npx wrangler d1 create relaykit                      # 把 id 填进 wrangler.jsonc
npx wrangler d1 migrations apply relaykit --remote
npx wrangler r2 bucket create relaykit-media         # 商品图本地化存储
npx wrangler secret put ADMIN_TOKEN                  # openssl rand -hex 24
npx wrangler secret put POLYGON_ADDRESS
pnpm deploy
```

之后配置同步脚本（`scripts/sync-upstream.ts`）定时跑目录同步；它会顺带把
商品图下载压缩成 webp 推进 R2，店面全部引用自己的 `/media/*` 图片，
不再依赖上游图床。品牌图（og 分享卡等）的生成见 **[docs/image-prompts.md](./docs/image-prompts.md)**。

完整流程（含自定义域名与 Cron）见 **[docs/deployment.md](./docs/deployment.md)**。

### 部署到别处

它是标准 Next.js 应用，`pnpm build && pnpm start` 可跑在任何 Node 宿主上。
需要把 D1 驱动换成其它 Drizzle 驱动，并用自己的调度器跑定时任务。

## 健康检查

出问题时第一个该看的地方是 `/api/health`。它报告配置是否有效、数据库是否可达、
汇率是否新鲜、每条链的收款地址是否真的配好了、上游是否连通及余额多少 ——
**且不回显任何密钥**，所以可以直接贴出来求助。

```json
{
  "ok": false,
  "checks": [
    { "name": "config",          "ok": true,  "detail": "店铺「My Store」· 结算币 USDT · 1 个上游" },
    { "name": "database",        "ok": true,  "detail": "D1 可读写" },
    { "name": "fx",              "ok": true,  "detail": "汇率 4.0 小时前采集，在 24 小时窗口内" },
    { "name": "payments:polygon","ok": false, "detail": "收款地址仍是占位值，下单接口会拒绝建单" },
    { "name": "supplier:demo",   "ok": true,  "detail": "已连通，余额 5000.00" }
  ]
}
```

## 项目状态

如实说明 —— v0.1，客户侧链路已全通，剩余缺口集中在「全自动化」那一半。

| 模块 | 状态 |
|---|---|
| 上游适配器接口 + acg-faka 驱动 | ✅ 完成，42 个测试 |
| mock 上游（零凭据演示） | ✅ 完成 |
| 配置系统与校验 | ✅ 完成，24 个测试 |
| 定价引擎（汇率、加价、毛利护栏） | ✅ 完成，33 个测试 |
| 订单状态机（含预订、人工发货路径） | ✅ 完成，26 个测试 |
| 商品同步 + 店面列表（含销量、富文本清洗） | ✅ 完成 |
| D1 表结构与迁移 | ✅ 完成 |
| Cloudflare 部署 + Cron 接线 | ✅ 完成 |
| 链上收款监听（Polygon / BSC，多端点回退） | ✅ 完成，15 个测试 |
| 结账、订单页、订单查询（双语） | ✅ 完成 |
| 账号体系、余额账本、充值、优惠券 | ✅ 完成 |
| 预订（缺货占位、自助退余额） | ✅ 完成，6 个测试 |
| 管理端 API（订单列表 / 人工发货 / 退款） | ✅ 完成 |
| WAF 绕行方案（本地同步脚本 → 注入式落库） | ✅ 完成，见 docs/upstream-access.md |
| 图片本地化（R2 存储 + webp 压缩） | ✅ 完成，店面不热链上游图床 |
| 品牌资产（logo / favicon / og 分享卡） | ✅ 完成，见 docs/image-prompts.md |
| **在线客服浮窗** | ✅ 完成（配 `store.supportUrl` 即启用） |
| **管理后台界面** | ⬜ 未开始（先用 `GET/POST /api/admin/orders`） |
| **TRON (TRC20) 收款监听** | ⬜ 未开始（明确报错，不静默） |
| **端到端浏览器测试** | ⬜ 未开始 |

现在部署可以真实收款（USDT，Polygon / BSC）、自动确认、按配置自动或人工发货。
距离「全自动」还差的是上游对接凭据（app_id/app_key，见 docs/upstream-access.md），
不是店面代码。

## 几个设计决定

都是容易做错、且做错了事后很贵的地方。

**「结果不确定」不等于「失败」。** 向上游下单超时时，钱可能扣了也可能没扣。
RelayKit 绝不自动重试这类订单；它用同一个幂等键重发一次，靠上游的重复检测
响应反推第一次究竟发生了什么。四种结局分别处理，其中「已扣款但卡取不回来」
那一种一律转人工 —— 绝不自动退款，否则就是既赔货又赔钱。

**已付款的订单永远不会被作废。** 支付窗口定时器和链上确认是两个独立时钟，
客户卡着窗口末尾付款必然会撞上。穷举测试遍历每一组 (状态 × 事件)，
证明付款之后没有任何路径能到达 `expired`。

**成本为 0 不等于白拿的货。** 上游漏返拿货价时拒绝定价而不是按 0 算 ——
否则售价会等于加价额本身，卖一单赔一单货钱。

**汇率过期就停售。** 静态汇率不会自己更新。超过 `maxStalenessHours` 后
目录自动下架，而不是继续按老汇率卖。

## 开发

```bash
pnpm test             # 单元 + 集成测试（vitest）
pnpm typecheck        # 应用
pnpm typecheck:worker # Cloudflare 入口（需在 build 之后跑）
pnpm preview          # 在真实 Workers 运行时里本地跑
```

适配器的测试跑在一个本地假上游上，它**复刻了真实协议里那些别扭的地方** ——
包括重复的幂等键返回错误而不是回放原结果。假上游如果比真上游友好，
测试只会给出虚假的安全感。

## 参与贡献

欢迎 issue 和 PR。新增上游驱动只需在 `src/supplier/` 实现 `SupplierAdapter`
并在 `src/supplier/factory.ts` 注册 —— 其它地方都不用动。

## 许可

MIT，见 [LICENSE](./LICENSE)。

转售行为可能受上游条款、被转售商品所属平台的条款、以及你和你客户所在地法律的
约束。这是使用者的责任，不是这套软件的。
