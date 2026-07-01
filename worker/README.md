# EdenMish Ops Worker

Cloudflare Worker + D1 — the delivery-ops backend and **source of truth** for
EdenMish orders, tracking, pricing, ops dashboard, and payment reconciliation.

> Canonical references live in `../docs/` (architecture, payment modes, status
> model, environment). AI operating rules: `../AGENTS.md`.

---

## What this Worker does

- Creates internal delivery orders (D1) with unique tracking tokens.
- Computes indicative pricing and flags orders that need manual review.
- Serves the **customer tracking page** (status timeline + live GPS map + OTP gate).
- Serves the **ops dashboard** (PIN login, order queue, status stepper, GPS broadcast).
- Creates Shopify **Draft Orders** (Worker-side charge) for review/manual payments.
- Receives and verifies the **Shopify `orders/paid` webhook** to reconcile payments.
- Sends email notifications (SendGrid) — customer OTP/confirmation + Eden alerts.

It is a **single Worker** that routes by hostname (`find.` vs `ops.`).

## Domains

| Host | Purpose | Entry |
|---|---|---|
| `find.edenmish.com` | Customer-facing tracking page | `GET /t/:token` → `pages.js#trackingHtml` |
| `find.edenmish.com` | Public order API | `POST /api/orders`, `GET /api/orders/:token`, `/verify-otp`, `/resend-otp` |
| `ops.edenmish.com` | Ops/driver dashboard | `GET /` → `pages.js#opsHtml` |
| `ops.edenmish.com` | Ops API (session-gated) | `/api/ops/login`, `/api/ops/orders`, `…/status`, `…/gps`, `…/approve` |
| (any) | Shopify webhook | `POST /webhooks/shopify` |

`find.edenmish.com/` (root) redirects to the Shopify booking site (`BOOKING_URL`).

## Main files (`src/`)

| File | Responsibility |
|---|---|
| `index.js` | Request router + endpoint handlers (create order, tracking, ops, webhook). Host-based routing. |
| `db.js` | D1 data access: `createOrder`, `setOrderStatus` (+ appends `status_history`), `getOrderByToken/Id`, `listOrders`, `getStatusHistory`, `addGps`/`latestGps`, `recordPayment`, `getRules`, `setEmailAndOtp`/`verifyOtp`. |
| `pricing.js` | Automatic pricing + exception detection (`priceOrder`). Gush-Dan zone allow-list, km/urgency rules. |
| `payment.js` | **Clean payment boundary.** `createCharge()` / `settleOrder()`. `immediate` mode today; `preauth` (Mesh) stubbed for the future. |
| `integrations.js` | Shopify Admin API (`createDraftOrder`), Shopify webhook HMAC verify (`verifyShopifyWebhook`), webhook parser (`parseShopifyOrderWebhook`), SendGrid email (`sendEmail`), OTP helpers, ops session (signed cookie). |
| `pages.js` | Server-rendered HTML for the tracking page (`trackingHtml`) and ops dashboard (`opsHtml`). |

## Local dev

From `package.json`:

```bash
npm install
npm run dev            # wrangler dev  (local Worker on http://localhost:8787)
```

> `wrangler dev` routes by host header. To exercise `find.`/`ops.` locally, use
> `/etc/hosts` entries pointing those names at `127.0.0.1`, or test the path-level
> endpoints directly. **Do not run `npm run deploy` unless explicitly asked.**

## Deployment (reference only — do not run without explicit approval)

```bash
wrangler deploy        # publishes to find.edenmish.com + ops.edenmish.com (custom domains in wrangler.toml)
```

Account and D1 IDs are configured in `wrangler.toml` (`[[d1_databases]]`,
`routes`). `account_id` is read from the `CLOUDFLARE_ACCOUNT_ID` env var.

## D1 setup

```bash
npm run db:init        # wrangler d1 execute edenmish --file=./schema.sql
npm run db:query -- "<SQL>"   # ad-hoc query
```

Database name: `edenmish`. Binding: `DB`.

### ⚠️ Schema cleanup is deferred to a later PR

`schema.sql` currently defines the **full** current schema (including the
columns that migrations `001`/`002` add). The migrations (`ALTER TABLE … ADD
COLUMN …`) have **no `IF NOT EXISTS`**, so running both `schema.sql` and the
migrations on a fresh database can fail with "duplicate column".

- For a **fresh** DB: run **only** `schema.sql` (`npm run db:init`).
- Do **not** attempt to "fix" the schema/migration overlap in this PR — it is
  scheduled for a later data-model PR. Just be aware of it.

The current tables: `orders` (wide), `status_history`, `gps_pings`, `payments`,
`pricing_rules`. See `../docs/STATUS_MODEL.md` and `../docs/ARCHITECTURE.md`.

## Secret checklist

All secrets are set via `wrangler secret put <NAME>`. They **no-op cleanly** if
unset (code checks for their presence). See `../docs/ENVIRONMENT.md` for the
full list and placeholders.

| Secret | Required for | Notes |
|---|---|---|
| `OPS_PIN` | ops dashboard login | shared PIN today |
| `SESSION_SECRET` | signed ops cookie + OTP hashing | falls back to `'dev'` if unset (do NOT leave as `dev` in prod) |
| `MAPS_KEY` | tracking page live map (injected into HTML) | Google Maps JS key |
| `SHOPIFY_ADMIN_TOKEN` | creating Draft Orders (`shpat_…`) | Worker-side charge |
| `SHOPIFY_WEBHOOK_SECRET` | verifying `orders/paid` webhook | webhook fails closed (401) if unset |
| `SENDGRID_API_KEY` | all email notifications | currently SendGrid |

Non-secret vars live in `wrangler.toml [vars]`: `BRAND`, `BOOKING_URL`,
`WHATSAPP_NUMBER`, `OPS_EMAIL`, `SHOPIFY_SHOP`, `SHOPIFY_API_VERSION`.

## Webhook checklist

Shopify admin → **Settings → Notifications → Webhooks**:

- **Event:** `Order payment` (= `orders/paid`) → **URL:** `https://ops.edenmish.com/webhooks/shopify`, **Format:** JSON.
- Copy the **Webhook signature key** → `wrangler secret put SHOPIFY_WEBHOOK_SECRET`.
- The Worker verifies HMAC-SHA256 (`verifyShopifyWebhook`) on every hit before
  trusting the payload. It recovers the tracking token from the line-item
  `_tracking_token` property (legacy cart path) **or** the draft-order
  metafield/note (Draft Order path).

See `../doc/payplus-setup.md` for the step-by-step Shopify + PayPlus setup.
