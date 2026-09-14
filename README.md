# RelayKit

**A self-hostable storefront for reselling digital goods.** Connect an upstream
supplier, set your markup, take crypto payments, deliver automatically.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dushaobindoudou/relaykit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[中文文档](./README.zh-CN.md) · [Configuration](./docs/configuration.md) · [Deployment](./docs/deployment.md)

---

## What this is

You have a source for digital goods — software licences, subscription codes,
gift cards, game top-ups — and you want to resell them under your own brand,
in your own currency, to your own audience. RelayKit is the machinery between
those two facts:

```
 Customer ──▶ Your storefront ──▶ Upstream supplier
              │                    │
              │ crypto checkout    │ places the real order
              │ your markup        │ returns the code
              ▼                    ▼
           Order state machine ──▶ Delivered
```

One YAML file configures the whole thing. No code changes to open a shop.

**What it is not:** a payment processor, an escrow service, or a source of
goods. You bring the supplier relationship and the receiving wallet.

## Why you might want it

- **Supplier-agnostic.** Business logic talks to a `SupplierAdapter` interface,
  never to a specific vendor's protocol. Switching suppliers is one new file —
  the storefront, checkout, order state machine and delivery are untouched.
- **Money-safe by construction.** Every decimal is a string, never a float.
  Pricing refuses to quote when cost is missing or the FX rate is stale. The
  order state machine makes "a paid order gets voided" and "we order twice from
  the supplier" structurally impossible, both verified by exhaustive tests.
- **Runs on free-tier Cloudflare.** Workers + D1 + Cron Triggers. No servers,
  no containers, no database to babysit.
- **Boots with zero credentials.** A built-in mock supplier means
  `git clone && pnpm dev` gives you a working shop you can click through before
  you talk to anyone.

## Quick start

```bash
git clone https://github.com/dushaobindoudou/relaykit
cd relaykit
pnpm install
pnpm dev
```

That runs against the bundled demo supplier — real pricing, real order records,
fake goods. Open http://localhost:3000 to see the storefront and
http://localhost:3000/api/health for a diagnosis of your setup.

To point it at a real supplier, copy the example config and edit it:

```bash
cp relaykit.config.example.yaml relaykit.config.yaml
```

## Configuration

Everything lives in `relaykit.config.yaml`. Structure goes in the file; secrets
stay in environment variables via `${VAR}` references, so the config file is
safe to commit and safe to paste into an issue when you need help.

```yaml
store:
  name: "My Digital Store"
  currency: USDT
  baseUrl: "https://shop.example.com"

suppliers:
  - id: primary
    driver: acgfaka                       # or `mock` for the demo supplier
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
    amount: "1"                           # 1 USDT per order
  minMarginPercent: 5                     # below this, items are delisted
  maxStalenessHours: 24                   # stale FX stops sales

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

Three settings decide whether you make or lose money — they have no safe
default, so you must write them yourself:

| Setting | What happens if you get it wrong |
|---|---|
| `pricing.fx.rates` | Every price is wrong by the size of your error |
| `pricing.markup` | Fixed markup dilutes as ticket price rises; a flat "1" is 28% margin on a $2.50 item and 5.9% on a $16 one |
| `pricing.minMarginPercent` | Set to 0 and an upstream price hike sells your stock below cost |

Full reference: **[docs/configuration.md](./docs/configuration.md)**.

## Deploy

### Cloudflare (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dushaobindoudou/relaykit)

Provisions the D1 database, prompts for the secrets declared in
`.dev.vars.example`, and deploys. Then edit `relaykit.config.yaml` in your fork
and push.

### Cloudflare (manual)

```bash
pnpm install
npx wrangler d1 create relaykit                      # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply relaykit --remote
npx wrangler r2 bucket create relaykit-media         # product image storage
npx wrangler secret put ADMIN_TOKEN                  # openssl rand -hex 24
npx wrangler secret put POLYGON_ADDRESS
pnpm deploy
```

Full guide, including custom domains and the Cron schedule:
**[docs/deployment.md](./docs/deployment.md)**.

### Anywhere else

It is a standard Next.js app. `pnpm build && pnpm start` works on any Node
host; you will need to swap the D1 driver for another Drizzle driver and run
the Cron jobs with your own scheduler.

## Health check

`/api/health` is the first place to look when something is wrong. It reports
config validity, database reachability, FX freshness, whether each receiving
address is actually configured, and upstream connectivity and balance — without
echoing any secret, so you can paste the output when asking for help.

```json
{
  "ok": false,
  "checks": [
    { "name": "config",         "ok": true,  "detail": "Store 'My Store' · USDT · 1 supplier" },
    { "name": "database",       "ok": true,  "detail": "D1 reachable" },
    { "name": "fx",             "ok": true,  "detail": "rate 4.0h old, within 24h window" },
    { "name": "payments:polygon","ok": false, "detail": "address is still a placeholder" },
    { "name": "supplier:demo",  "ok": true,  "detail": "connected, balance 5000.00" }
  ]
}
```

## Project status

Honest state of things — v0.1. The customer-facing pipeline is complete; the
remaining gaps are all on the "full automation" side.

| Area | Status |
|---|---|
| Supplier adapter interface + acg-faka driver | ✅ Done, 42 tests |
| Mock supplier (zero-credential demo) | ✅ Done |
| Configuration + validation | ✅ Done, 24 tests |
| Pricing engine (FX, markup, margin guards) | ✅ Done, 33 tests |
| Order state machine (incl. reservations, manual fulfillment) | ✅ Done, 26 tests |
| Catalog sync + storefront listing (sales badges, rich-text sanitizing) | ✅ Done |
| D1 schema + migrations | ✅ Done |
| Cloudflare deploy + Cron wiring | ✅ Done |
| On-chain payment watcher (Polygon / BSC, multi-RPC fallback) | ✅ Done, 15 tests |
| Checkout, order page, order lookup (EN/中文) | ✅ Done |
| Accounts, balance ledger, top-ups, coupons | ✅ Done |
| Backorders (pay to hold, self-serve refund to balance) | ✅ Done, 6 tests |
| Admin API (order list / manual fulfillment / refunds) | ✅ Done |
| WAF workaround (local sync script → injected ingest) | ✅ Done, see docs/upstream-access.md |
| Image localization (R2 storage + webp compression) | ✅ Done — storefront never hotlinks the upstream image host |
| Brand assets (logo / favicon / og share card) | ✅ Done, see docs/image-prompts.md |
| **Support chat widget** | ✅ Done (set `store.supportUrl`) |
| **Admin console UI** | ⬜ Not started (use `GET/POST /api/admin/orders` meanwhile) |
| **TRON (TRC20) payment watching** | ⬜ Not started (fails loudly, not silently) |
| **Browser end-to-end tests** | ⬜ Not started |

You can deploy it today, take real USDT payments (Polygon / BSC), confirm them
on-chain, and fulfill automatically or by hand. What still stands between you
and full automation is upstream credentials (app_id/app_key, see
docs/upstream-access.md) — not storefront code.

## Design notes

A few decisions that are easy to get wrong and expensive to fix later.

**An ambiguous purchase is not a failed purchase.** When the request to the
supplier times out, the money may or may not have moved. RelayKit never retries
such an order automatically; it re-sends once with the same idempotency key and
uses the supplier's duplicate-detection response to work out what actually
happened. The four outcomes are handled separately, and the one that means
"charged, code unrecoverable" goes to a human — never to an automatic refund,
which would lose both the goods and the money.

**A paid order can never be voided.** The payment window timer and on-chain
confirmation are independent clocks that will race whenever a customer pays in
the last seconds of the window. An exhaustive test walks every
(state × event) pair to prove no path reaches `expired` after payment.

**Cost of zero is not free goods.** If a supplier omits the wholesale price,
the item is refused rather than priced — otherwise the sale price would equal
the markup alone and every sale would lose the cost of the goods.

**Stale FX stops sales.** Static exchange rates never update themselves.
Past `maxStalenessHours` the catalog delists rather than keep selling at an
old rate.

## Development

```bash
pnpm test            # unit + integration (vitest)
pnpm typecheck       # app
pnpm typecheck:worker # Cloudflare entrypoint (run after a build)
pnpm preview         # build and run the real Workers runtime locally
```

The adapter test suite runs against a local fake upstream that reproduces the
real protocol's awkward parts — including returning an *error* for a duplicate
idempotency key rather than replaying the original result. A friendlier fake
would give false confidence.

## Contributing

Issues and pull requests welcome. If you add a supplier driver, implement
`SupplierAdapter` in `src/supplier/` and register it in `src/supplier/factory.ts`
— nothing else should need to change.

## Licence

MIT — see [LICENSE](./LICENSE).

Reselling may be restricted by your supplier's terms, the terms of the platform
whose goods you resell, and the law where you and your customers are. That is
your responsibility, not the software's.
