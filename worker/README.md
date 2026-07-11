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

Staging uses separate hosts and a separate D1 database:
`find-staging.edenmish.com`, `ops-staging.edenmish.com`, and
`edenmish-staging`. It never shares production orders or credentials.

`find.edenmish.com/` (root) redirects to the Shopify booking site (`BOOKING_URL`).

## Main files (`src/`)

| File | Responsibility |
|---|---|
| `index.js` | Request router + endpoint handlers (create order, tracking, ops, webhook). Host-based routing. |
| `db.js` | D1 data access: `createOrder`, `setOrderStatus`, `getOrderByToken/Id`, `listOrders`, `getStatusHistory`, `addGps`/`latestGps`, `recordPayment`, `getRules`, `setEmailAndOtp`/`verifyOtp`, rate-limit helpers, delivery-proof helpers, notification-audit helpers. |
| `pricing.js` | Automatic pricing + exception detection (`priceOrder`). Gush-Dan zone allow-list, km/urgency rules. |
| `payment.js` | **Clean payment boundary.** `createCharge()` / `settleOrder()`. `immediate` mode today; `preauth` (Mesh) stubbed for the future. |
| `integrations.js` | Shopify Admin API (`createDraftOrder`), Shopify webhook HMAC verify (`verifyShopifyWebhook`), webhook parser (`parseShopifyOrderWebhook`), SendGrid email (`sendEmail`), OTP helpers, ops session (signed cookie). |
| `pages.js` | Server-rendered HTML for the tracking page (`trackingHtml`) and ops dashboard (`opsHtml`). |
| `status.js` | Shared status model: `STATUS`, `STATUS_META` (labels, lifecycle, live-GPS, queue buckets, next-status), `QUEUE_LAYOUT`, helpers. Single source of truth for both UIs. |
| `security.js` | PII sanitizer (`publicOrderSummary`), `maskEmail`, `corsFor` (CORS allowlist), `clientIp`, `anonKey` (hashed IP rate-limit keys). |
| `notify.js` | Email notification wrapper (`notifyEmail`): best-effort audit trail in D1 `notifications`; never throws. |

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

The staging deployment uses `wrangler.staging.toml` as a template. Render it
with `scripts/render-staging-config.mjs`; the generated config is gitignored.
GitHub Actions deploys it through `.github/workflows/staging-worker.yml` after
the one-time staging D1 and environment-secret setup documented in
`../docs/CI_CD.md`.

## D1 setup

```bash
npm run db:init        # wrangler d1 execute edenmish --file=./schema.sql
npm run db:query -- "<SQL>"   # ad-hoc query
```

Database name: `edenmish`. Binding: `DB`.

### Schema and migrations

`schema.sql` is the **fresh-DB source of truth** — it defines every current table.
The numbered migrations (`003`–`010`) add tables/columns that were introduced after the
initial schema. Tables are idempotent (`CREATE TABLE IF NOT EXISTS`); `ALTER TABLE …
ADD COLUMN` migrations (`006`–`010`) must run only on DBs that predate their columns.

- **Fresh DB:** run `npm run db:init` (schema.sql only).
- **Existing production DB:** run numbered migrations in order — see **`MIGRATIONS.md`**
  for the full checklist, commands, and verification queries.
- Do not run the old `001`/`002` migrations on a DB where `schema.sql` has run (their
  `ALTER TABLE … ADD COLUMN` would fail with "duplicate column").

Current tables: `orders`, `status_history`, `gps_pings`, `payments`, `pricing_rules`,
`rate_limits`, `delivery_proofs`, `notifications`, `coupons`, `coupon_redemptions`.

## Secret checklist

All secrets are set via `wrangler secret put <NAME>`. Optional integrations no-op
if unset, while sessions and OTP creation fail closed without `SESSION_SECRET`.
See `../docs/ENVIRONMENT.md` for the full list and placeholders.

| Secret | Required for | Notes |
|---|---|---|
| `OPS_PIN` | ops dashboard login | shared PIN today |
| `SESSION_SECRET` | signed ops cookie + OTP hashing | mandatory; auth/order OTP flows fail closed if unset |
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

---

## Production deployment checklist

### 1. Pull latest main

```bash
git checkout main
git pull --ff-only origin main
cd worker
```

### 2. Run required D1 migrations

See **`MIGRATIONS.md`** for the full reference (purpose, verification queries, order).

```bash
wrangler d1 execute edenmish --remote --file=./migrations/003_rate_limits.sql
wrangler d1 execute edenmish --remote --file=./migrations/004_delivery_proofs.sql
wrangler d1 execute edenmish --remote --file=./migrations/005_notifications.sql
wrangler d1 execute edenmish --remote --file=./migrations/006_pod_signature.sql
wrangler d1 execute edenmish --remote --file=./migrations/007_order_rating.sql
wrangler d1 execute edenmish --remote --file=./migrations/008_coupons.sql
wrangler d1 execute edenmish --remote --file=./migrations/009_invoice_tracking.sql
wrangler d1 execute edenmish --remote --file=./migrations/010_order_service_schedule.sql
```

> Run only migrations that have not already been applied. Several `ALTER TABLE`
> migrations are not idempotent and will fail if repeated.

### 3. Required Worker secrets

```bash
wrangler secret put OPS_PIN
wrangler secret put SESSION_SECRET
wrangler secret put MAPS_KEY
wrangler secret put SHOPIFY_ADMIN_TOKEN
wrangler secret put SHOPIFY_WEBHOOK_SECRET
wrangler secret put SENDGRID_API_KEY
```

**Future only** (do not set today):

```bash
wrangler secret put MESH_API_KEY    # future Mesh/J5 preauth — not required
```

### 4. Required Worker vars

Set in `wrangler.toml [vars]` (non-secret):

| Var | Value |
|---|---|
| `BRAND` | EdenMish |
| `BOOKING_URL` | `https://edenmish.com` |
| `WHATSAPP_NUMBER` | Eden's WhatsApp (international, no `+`) |
| `OPS_EMAIL` | Eden's ops alert address |
| `SHOPIFY_SHOP` | `edenmish.myshopify.com` |
| `SHOPIFY_API_VERSION` | `2026-04` |
| `ALLOWED_ORIGINS` | `https://edenmish.com,https://www.edenmish.com,https://v2.edenmish.com,https://dash.edenmish.com,https://edenmish-v2.pages.dev` |

> `ALLOWED_ORIGINS` controls CORS and is required for the credentialed ops cookie.
> Shopify theme-preview domains may need to be added temporarily during testing.

### 5. Shopify webhook

- **Event:** `Order payment` (= `orders/paid`)
- **URL:** `https://ops.edenmish.com/webhooks/shopify`
- **Format:** JSON
- **Secret:** set in the Worker as `SHOPIFY_WEBHOOK_SECRET` (see step 3).

### 6. Deploy Worker

```bash
wrangler deploy
```

> **Do not run `wrangler deploy` unless explicitly approved.**

### 7. Smoke test

- [ ] Submit a normal order from the EdenMish funnel.
- [ ] Confirm D1 order created.
- [ ] Confirm `payment_url` returned for exact-price order.
- [ ] Confirm Draft Order invoice opens Shopify checkout.
- [ ] Confirm paid webhook marks order paid.
- [ ] Confirm tracking page requires OTP before PII.
- [ ] Confirm ops dashboard buckets show the order.
- [ ] Confirm inline price approval works for a review order.
- [ ] Confirm delivery proof can be saved (receiver name + note).
- [ ] Confirm notification audit rows are created.
- [ ] Confirm per-order notification history appears in ops.
