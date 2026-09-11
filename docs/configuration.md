# 配置参考

RelayKit 的全部行为由一份 `relaykit.config.yaml` 决定。开一家店不需要改代码。

**结构进文件，密钥进环境变量。** 任何字符串值都支持 `${VAR}` 与
`${VAR:-默认值}` 插值，因此配置文件可以安全地提交进仓库、可以直接贴进 issue
求助，而 `appKey`、收款地址这些不会出现在里面。

引用了未设置的环境变量时，**启动会直接失败**而不是静默留空 —— 留空会让
`appKey` 变成 `""`，然后在第一笔真实订单上以「密钥错误」爆出来，那时客户已经付款了。

---

## 目录

- [store — 店铺](#store--店铺)
- [suppliers — 上游供货](#suppliers--上游供货)
- [pricing — 定价](#pricing--定价)
- [payments — 收款](#payments--收款)
- [fulfillment — 履约](#fulfillment--履约)
- [alerts — 告警](#alerts--告警)
- [常见配置错误](#常见配置错误)

---

## store — 店铺

```yaml
store:
  name: "My Digital Store"
  currency: USDT              # 面向客户展示与结算的币种
  locale: en                  # en | zh-CN
  baseUrl: "https://shop.example.com"
  supportEmail: "support@example.com"
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 店名，出现在页面与订单上 |
| `currency` | | 默认 `USDT`。所有对客报价都以它计 |
| `locale` | | 默认 `en` |
| `baseUrl` | ✅ | 站点根地址，用于生成订单页绝对链接与 SEO canonical |
| `supportEmail` / `supportUrl` | | 留空则页面不展示联系入口 |

---

## suppliers — 上游供货

可以配多个，商品会合并展示。

```yaml
suppliers:
  - id: primary
    driver: acgfaka
    domain: "https://upstream.example.com"
    appId: "${SUPPLIER_APP_ID}"
    appKey: "${SUPPLIER_APP_KEY}"
    currency: CNY
    timeoutMs: 20000
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 本地标识，小写字母/数字/连字符。**定了就别改** —— 它写在历史订单里 |
| `driver` | ✅ | `acgfaka` 或 `mock` |
| `domain` `appId` `appKey` | driver=acgfaka 时✅ | 上游凭据 |
| `currency` | | 上游的结算币，默认 `CNY` |
| `timeoutMs` | | 单次请求超时，默认 20000 |

### driver: mock

内置的内存假上游，**不需要任何凭据、不碰真钱**。用来在谈上游之前先把店跑通。

它走的是和真上游完全相同的代码路径，包括那些反直觉的行为（例如重复的幂等键
返回错误而不是回放原结果）。这是刻意的 —— 假上游如果比真上游友好，基于它
开发的异常处理逻辑上线就会失效。

### driver: acgfaka

对接任何运行 [acg-faka](https://github.com/lizhipay/acg-faka)（异次元发卡）的
上游站点，走它内建的「共享店铺 / 商品对接」协议。

你需要向上游站长要两样东西：

1. **`app_id` 与 `app_key`** —— 商户凭据
2. **为要转售的商品开启「开放对接」**（后台的 `api_status`）

第二项经常被忽略。没开的话，凭据是好的但每个商品都会报「该商品未开放对接」。

连接失败时 `/api/health` 会区分两种原因，直接对应要去改什么：

| 上游返回 | 含义 |
|---|---|
| `商户ID不存在` | `appId` 填错了（签名还没被校验到） |
| `密钥错误` | `appId` 对，但 `appKey` 不匹配 |

---

## pricing — 定价

**这一节决定你赚钱还是赔钱。** 三个字段没有安全默认值，必须自己想清楚再填。

```yaml
pricing:
  fx:
    source: static
    rates:
      CNY_USDT: "0.1389"
    updatedAt: "2026-09-11T00:00:00Z"
  markup:
    type: fixed
    amount: "1"
  minMarginPercent: 5
  maxStalenessHours: 24
  rounding:
    mode: up
    increment: "0.01"
  overrides: []
```

### fx — 汇率

```yaml
fx:
  source: static
  rates:
    CNY_USDT: "0.1389"        # 含义：1 CNY = 0.1389 USDT
  updatedAt: "2026-09-11T00:00:00Z"
```

汇率键的格式是 `FROM_TO`。反向汇率会自动取倒数，所以配了 `CNY_USDT` 就不必
再配 `USDT_CNY`。

**`updatedAt` 强烈建议填。** 静态汇率不会自己更新；填了它，
`maxStalenessHours` 的陈旧保护才真正生效。不填则视为「刚刚采集」——
否则所有人首次部署都会因为陈旧检查而全站无货，这个失败模式太难自查。

### markup — 加价

```yaml
markup:
  type: fixed       # fixed | percent
  amount: "1"       # fixed 以 store.currency 计；percent 是百分数
```

**固定加价的毛利率随客单价上升而下降。** 同样加 1 USDT：

| 成本 | 售价 | 毛利率 |
|---|---|---|
| ≈2.5 USDT | 3.5 | 约 28% |
| ≈16 USDT | 17.1 | 约 5.9% |

所以高客单商品要么改用 `percent`，要么用下面的 `overrides` 单独设定。

### minMarginPercent — 最低毛利护栏

毛利率 = `(售价 − 成本) ÷ 售价`。**注意分母是售价不是成本。**

低于这个值的商品会被自动下架，而不是继续卖。它防的是两件事：上游涨价、
汇率跳动。设成 `0` 等于关闭保护，配置校验会因此拒绝启动（除非显式允许警告）。

选值时记得把链上手续费算进去 —— 毛利低于手续费的订单是纯亏。

### rounding — 取整

```yaml
rounding:
  mode: up          # up = 向上取整保毛利；nearest = 四舍五入
  increment: "0.01"
```

默认向上。薄毛利场景下向下抹零会把利润磨掉。

### overrides — 单品覆盖

```yaml
overrides:
  - supplier: primary
    code: "ABC123"            # 上游商品的对接 CODE
    race: "1年"               # 可选；留空表示该商品所有规格
    markup: { type: percent, amount: "20" }
```

带 `race` 的规则比只匹配 `code` 的更具体，优先生效。

---

## payments — 收款

```yaml
payments:
  windowMinutes: 30
  chains:
    - id: polygon             # polygon | bsc | tron | ethereum
      enabled: true
      address: "${POLYGON_ADDRESS}"
      confirmations: 30
      rpcUrl: ""              # 可选，留空用公共节点
  amountTagging:
    enabled: true
    decimals: 4
```

> ⚠️ **`address` 是钱的去处。** 配错等于把收入送给别人。部署前逐字核对。
>
> 未配置时（值为 `UNSET` 等占位符）站点**仍能启动**以便查看演示，但
> `/api/health` 会标红，下单接口会拒绝建单。占位值不可能悄悄进入生产。

### 选哪条链

链上手续费直接吃掉薄毛利订单。**Polygon 与 BSC 是分币级，TRC20 的单笔费用
可能吞掉整笔 1 USDT 的差价。** 建议优先引导前两者，TRC20 作为兜底
（很多海外用户手里只有 TRC20）。

给上游打款同理：用**整笔预充余额**而不是按单转账，每单从余额扣，链上零手续费。

### confirmations — 确认数

给低了有重组风险，给高了客户等得久。默认值按各链常见安全线给，
大额场景应当调高。

### amountTagging — 金额打标

同一个收款地址靠唯一的小数尾数区分订单，省掉为每单派生地址的密钥管理。

代价是并发订单数受尾数空间限制。`decimals: 4` 在小额场景下够用；
如果高峰期出现「分配不出唯一金额」，调大它。

---

## fulfillment — 履约

```yaml
fulfillment:
  mode: auto                        # auto | manual
  balanceAlertThreshold: "200"
  haltSalesOnLowBalance: true
```

| 字段 | 说明 |
|---|---|
| `mode` | `auto` = 收款确认后自动向上游下单；`manual` = 只记账，人工发货 |
| `balanceAlertThreshold` | 上游余额低于此值告警 |
| `haltSalesOnLowBalance` | 余额不足时自动下架，避免继续收钱却发不出货 |

**阈值至少留够三天流水。** 上游余额耗尽会让整站停摆，而且是**客户已经付款
之后**才发现 —— 这是这套系统里最难收拾的故障。

---

## alerts — 告警

```yaml
alerts:
  webhookUrl: "${ALERT_WEBHOOK_URL}"
  telegram:
    botToken: "${TG_BOT_TOKEN}"
    chatId: "${TG_CHAT_ID}"
```

整段可以省略或留空。

---

## 常见配置错误

配置校验分两层：zod 管单字段，另有一层跨字段一致性检查，专门拦那些
**每个字段单看都合法、合起来却会亏钱**的组合。

| 报错 | 原因与修法 |
|---|---|
| `引用了未设置的环境变量 ${X}` | 执行 `wrangler secret put X`，或用 `${X:-默认值}` 给个兜底 |
| `pricing.fx.rates: 缺少 "CNY_USDT"` | 上游结算币与展示币不同，必须提供这条汇率 |
| `payments.chains: "polygon" 重复配置` | 同一条链配了两次，会导致重复入账 |
| `pricing.overrides[0].supplier: "X" 不在 suppliers 列表里` | 改了 `supplier.id` 却忘了同步改 overrides |
| `payments.chains: 所有链都被禁用了` | 店能开但没人付得了款 |
| `minMarginPercent 为 0` | 已关闭毛利保护。确认无误后用 `allowWarnings` 放行 |
| `必须是十进制数字字符串` | 金额要写成 `"1.5"` 而不是 `1.5` 或 `1e-2`。YAML 里的裸数字会变成浮点 |

### YAML 空段落

把一整段注释掉在 YAML 里解析出来是 `null`：

```yaml
alerts:
  # webhookUrl: "..."
```

这是完全自然的写法，RelayKit 对所有可选段落都做了容错，会落到默认值。

---

## 改完配置之后

配置在**构建期**被编译进产物（Workers 上没有文件系统），所以改完必须重新部署：

```bash
pnpm deploy
```

然后看 `/api/health` 确认。
