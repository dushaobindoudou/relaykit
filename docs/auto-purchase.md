# 自动中转采购（二道贩子模式）

> 客户付款 → 我们自动向上游游客下单 → 热钱包自动付款 → 轮询收卡 → 自动交付。
> 差价（默认 20%）留在我们钱包里，全程无人工。

## 一、原理

上游（acg-faka 前台）的购买流程不需要任何凭据，全部接口逆向自
zhanghao66.com 前台 JS（ACG发卡 v3.6.0 Tokyo 主题），2026-09-14 全链路实测：

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 1 | `GET /item/{id}` | 商品页 `_var_item` JSON 内嵌 `order_confirm_hash`（下单确认条款哈希，服务端强校验） |
| 2 | `POST /user/api/order/trade` | form 表单：`item_id/race/num/contact/pay_id/order_notice_confirmed/order_confirm_agree/order_confirm_hash` → `{tradeNo, amount, url}`。**游客身份即可** |
| 3 | `GET /plugin/usdt/order/trade?tradeNo=` | USDT 收银台 HTML：精确应付金额（`data-clipboard-text`，如 `2.498`）+ 收款地址（`paymentAddress`）+ 链名。**20 分钟有效** |
| 4 | 我们热钱包转 exact 金额 | 上游按「到账金额完全一致」对账自动发货，多付少付都不发货 |
| 5 | `POST /plugin/usdt/api/query` `{tradeNo}` | 到账轮询，`data.status` 0→1 |
| 6 | `POST /user/api/index/secret` `{tradeNo, password:""}` | 取卡密（无查询密码的商品空密码即可） |

注意事项（都是实测踩出来的）：

- **USDT 通道有最低金额门槛**（¥5 单会被拒，¥25 单通过）。自动化里用
  `minBatchCny` 凑单：多买的余量留在上游发货结果里，相当于进了本地库存。
- **上游批发价自动生效**（如 3 件起单价下浮），实际成本比我们同步到的零售
  成本口径更低，毛利只会更高。
- **金额必须原样支付**：收银台的 `2.498` 是他们的换算结果，我们
  `parseUnits` 后直接转，绝不自己按汇率重算。
- 上游对 Cloudflare Workers 的出口 IP 返回 456（WAF），本地/自有服务器直连
  没问题 —— 所以 Worker 上的采购请求要经中继转发（见下）。

## 二、部署清单

1. **中继**（Worker 部署才需要）：找一台不被上游拦的机器跑
   `scripts/relay-upstream.mjs`：

   ```bash
   RELAY_SECRET=$(node -e "console.log(crypto.randomUUID())") \
     node scripts/relay-upstream.mjs
   ```

   然后配置两边：`daichong.config.yaml` 的 `suppliers[].relayUrl` 指向它，
   并 `wrangler secret put RELAY_SECRET` 注入同一个密钥。

2. **热钱包**：`wrangler secret put PAYOUT_WALLET_KEY` 注入 EVM 私钥。
   ⚠️ 这是能花钱的钥匙 —— 用**专用的、只放小金额**的钱包；它还需要在各链
   预存少量 gas 代币（Polygon 需 POL、BSC 需 BNB，每单成本不到 1 美分）。

3. **供应商配置**：`daichong.config.yaml` 里

   ```yaml
   suppliers:
     - id: upstream
       driver: acgfaka-public
       domain: "http://zhanghao66.com"
       relayUrl: "https://your-relay.example.com"   # 中继
       autoPurchase:
         enabled: true
         contact: "relay@your-shop.com"   # 游客下单身份，用可控邮箱
         payChannelId: 6                  # 6=USDT-polygon 5=BEP-USDT
         maxPayUsdt: "30"                 # 资金护栏：单笔付款上限
         minBatchCny: "25"                # 凑单门槛
   fulfillment:
     mode: auto
   ```

4. **加价**：`pricing.markup` 用 `percent`，`amount: "20"` 即客户价 =
   上游成本 × 1.2。汇率 `pricing.fx.rates.CNY_USDT` 影响客户端显示价。

5. **迁移**：`wrangler d1 migrations apply relaykit --remote`（0004 加了
   orders 表的上游侧字段）。

## 三、资金安全

- **单笔护栏** `maxPayUsdt`：上游应付超出即转人工（needs_review），绝不自动付。
- **不支持即不假装**：收银台链名解析不出 polygon/bsc（如 TRC20）→ 转人工。
- **私钥未配置** → 全部转人工，订单不会卡死在 procuring。
- **亏损路径进状态机**：
  - 上游拒绝下单（含缺货）→ `procurement_failed`（钱没出去，可退款）；
  - 付了款上游没发货/订单过期 → `needs_review`（人工对账，绝不静默重试）；
  - 未付款上游过期 → 自动重下（最多 3 次），之后转人工。
- 出款失败（RPC 抖动）不上报状态机 —— 钱还在钱包里，下一轮 cron 重试。

## 四、两个收款版本（20% / 30%）

| | 版本 A：链上 USDT（全自动） | 版本 B：支付宝/微信转账（人工确认） |
| --- | --- | --- |
| 客户价 | 成本 × 1.20（`pricing.markup`） | 成本 × 1.30（`payments.manual.markupPercent`） |
| 到账 | 链上监听自动确认 | 店主在收款 App 里看到转账后，调管理端确认 |
| 发货 | 自动采购管线 | **同一条**自动采购管线（确认后无区别） |
| 依赖 | POLYGON_ADDRESS 等 | ALIPAY_ACCOUNT / WECHAT_ACCOUNT（`wrangler secret put`） |

版本 B 的语义：

- 下单时不分配链上地址、不打金额标 —— watcher 按（地址, 金额）匹配，
  空字段天然不匹配，不会被误确认；
- 订单页展示收款账号/收款码/**¥ 应付金额**（按汇率换算，向上取整到分）
  和订单号（转账备注用）；24 小时未确认自动关单；
- 管理员确认：`POST /api/admin/orders`，body
  `{"action":"confirm-payment","orderId":"..."}`（ADMIN_TOKEN Bearer 鉴权）。
  待确认单用 `GET /api/admin/orders?status=awaiting_payment` 过滤
  `payMethod` 为 alipay/wechat 的行；
- 确认后 markPaid → paid → 每分钟 cron 走游客下单 + 热钱包付款 + 收卡交付，
  与链上单完全一致；
- 批发阶梯折扣在手动价上按比例保持（该档售价 ÷ 基础售价），买得多依旧便宜。

## 五、时序

每分钟 cron（`worker/entry.ts`）：

1. `watchAll` 扫链确认客户付款；
2. `fulfillPaidOrders` → `fulfillOrder` → 游客下单 + 解析收银台（秒级）；
3. `settleUpstreamPurchases`：未付的付款、已付的轮询到账、到账即收卡交付。

客户侧体验：付款确认后约 1–2 分钟内收到卡密（上游到账确认 + 我们轮询
周期各占一点时间）。订单详情页的事件流会显示「已向上游下单 / 已出款 /
已交付」全过程。
