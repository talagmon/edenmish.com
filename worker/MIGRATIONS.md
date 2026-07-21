# EdenMish Worker Migrations

Reference for every D1 migration and how to apply it.

---

## Rules

- Run migrations **after merging** the PR that introduced them and **before relying on the feature** in production.
- Run migrations in **numeric order** (003 → 004 → 005 → …).
- Table-creation migrations are idempotent, but `ALTER TABLE … ADD COLUMN` migrations are not. Run each numbered migration exactly once and verify before continuing.
- **Do not run `schema.sql` on an existing production DB.** It is for fresh-DB setup only.
- For a **fresh DB**, use `schema.sql` only (it already includes every current table).
- For an **existing production DB**, run only the numbered migrations that have not yet been applied.
- Never paste secrets in migration commands.
- Verify the target D1 database name (`edenmish`) before running commands.

---

## Fresh DB setup

```bash
wrangler d1 execute edenmish --file=./schema.sql
```

This creates the full current schema (all tables, indexes, and seed pricing rules).
Do **not** also run older migrations (`001`, `002`) — `schema.sql` already includes their
columns, and those migrations use `ALTER TABLE … ADD COLUMN` (no `IF NOT EXISTS`) which
would fail with "duplicate column" on a DB where `schema.sql` has already run.

---

## Existing production DB — migration order

### 003_rate_limits.sql

**Introduced by:** PR 5 — Harden tracking security and public endpoint abuse protection

**Purpose:** Adds the `rate_limits` table for:
- Order creation throttling (5 / 10 min, 20 / day per IP)
- OTP attempt lockout (max 5 failed / 10 min → 15-min lock)
- OTP resend throttling (max 3 / 15 min, 60 s minimum gap)

**Command:**
```bash
wrangler d1 execute edenmish --file=./migrations/003_rate_limits.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits';
```

---

### 004_delivery_proofs.sql

**Introduced by:** PR 7 — Add proof of delivery MVP

**Purpose:** Adds the `delivery_proofs` table for:
- Receiver name + delivery note at delivery time
- Reserved `photo_url` column (no upload implemented yet)

**Command:**
```bash
wrangler d1 execute edenmish --file=./migrations/004_delivery_proofs.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_proofs';
```

---

### 005_notifications.sql

**Introduced by:** PR 8 — Add notification audit table

**Purpose:** Adds the `notifications` table for:
- Email notification audit (sent / failed / skipped / pending)
- Per-order notification history
- Future WhatsApp/SMS notification audit

**Command:**
```bash
wrangler d1 execute edenmish --file=./migrations/005_notifications.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='notifications';
```

---

### 006_pod_signature.sql

**Introduced by:** PR 9 — PoD signature capture

**Purpose:** Adds the `signature` column to `delivery_proofs` for the customer's
digital signature captured at delivery (base64 PNG). The PoD photo reuses the
existing `photo_url` column.

**Command:**
```bash
wrangler d1 execute edenmish --file=./migrations/006_pod_signature.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('delivery_proofs') WHERE name='signature';
```

---

### 007_order_rating.sql

**Introduced by:** PR 10 — Customer delivery rating

**Purpose:** Adds the `rating` column (INTEGER, 1-5) to `orders` for the customer
delivery rating submitted from the v2 delivery-confirmation page
(`edenmish-v2/public/delivered.html`) via `POST /api/orders/:token/rate`.

**Command:**
```bash
wrangler d1 execute edenmish --file=./migrations/007_order_rating.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('orders') WHERE name='rating';
```

---

### 008_coupons.sql

**Introduced by:** Coupons PR (step 1) — D1 schema for discount codes

**Purpose:**
- Adds coupon snapshot columns to `orders`: `subtotal_price`, `discount_code`,
  `discount_amount`, `discount_title`.
- Adds the `coupons` table — the coupon definitions (percentage / fixed_amount,
  usage_limit, once-per-customer). Originally a synced snapshot of Shopify
  Admin discounts; coupons are now managed D1-only from the ops dashboard
  (the `shopify_discount_id` / `raw_shopify_json` columns are unused legacy).
- Adds the `coupon_redemptions` table — one row per redemption, used by the Worker
  to enforce usage limits via D1 counts.

**Command:**
```bash
# Local:
wrangler d1 execute edenmish --local --file=./migrations/008_coupons.sql
# Production:
wrangler d1 execute edenmish --remote --file=./migrations/008_coupons.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name IN ('coupons','coupon_redemptions');
SELECT name FROM pragma_table_info('orders') WHERE name IN ('subtotal_price','discount_code','discount_amount','discount_title');
```

---

### 009_invoice_tracking.sql

**Purpose:** Adds invoice reference fields to `orders` for invoice metadata returned by
the payment provider boundary.

**Command:**
```bash
wrangler d1 execute edenmish --remote --file=./migrations/009_invoice_tracking.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('orders') WHERE name IN ('invoice_number','invoice_url');
```

---

### 010_order_service_schedule.sql

**Purpose:** Persists the service level, package size, booking date, and booking hour
already accepted by the order API. These fields drive ops SLA deadlines, service
analytics, and customer tracking details.

**Command:**
```bash
wrangler d1 execute edenmish --remote --file=./migrations/010_order_service_schedule.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('orders')
WHERE name IN ('service','size','when_date','when_hour');
```

---

### 011_cancellation_requests.sql

**Purpose:** Adds the `cancellation_requests` table for durable online cancellation
notices. The table stores only the last four digits of the identity number; the full
number is validated in memory and is not persisted in D1.

**Command:**
```bash
wrangler d1 execute edenmish --remote --file=./migrations/011_cancellation_requests.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name='cancellation_requests';
```

---

### 014_driver_api_v1.sql

**Purpose:** Adds the scoped mobile-driver foundation: driver identities,
installation-bound hashed sessions, shifts, assignments, revisioned routes, and
idempotent execution events. Migration numbers 012–013 are reserved by parallel
security work and must be applied before 014 if those files are present at merge time.

**Commands:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote \
  --config wrangler.staging.generated.toml \
  --file=./migrations/014_driver_api_v1.sql

# Production (only after the production release is approved):
wrangler d1 execute edenmish --remote --file=./migrations/014_driver_api_v1.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name IN (
  'drivers', 'driver_sessions', 'driver_shifts', 'driver_assignments',
  'driver_routes', 'driver_route_stops', 'driver_execution_events'
);
```

---

### 015_driver_route_tasks.sql

**Purpose:** Extends immutable driver-route revisions so one order can contribute
independent pickup and drop-off tasks. Adds the task type, pickup-precedence
reference, expected service duration, and the revision's onboard-order snapshot.
Existing drop-off-only route revisions are treated as already collected and are
backfilled into that onboard snapshot.

**Commands:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote \
  --config wrangler.staging.generated.toml \
  --file=./migrations/015_driver_route_tasks.sql

# Production (only after the production release is approved):
wrangler d1 execute edenmish --remote --file=./migrations/015_driver_route_tasks.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('driver_routes')
WHERE name='onboard_order_ids_json';

SELECT name FROM pragma_table_info('driver_route_stops')
WHERE name IN (
  'task_type', 'required_predecessor_stop_id', 'service_duration_seconds'
);
```

---

### 016_driver_route_integrity.sql

**Purpose:** Stores bounded, shift-scoped driver location samples and adds a
deterministic fingerprint to immutable route revisions. Dispatch uses only fresh,
accurate samples as its origin, creates a new revision when routing inputs change,
and can safely detect a concurrently generated equivalent route.

**Commands:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote \
  --config wrangler.staging.generated.toml \
  --file=./migrations/016_driver_route_integrity.sql

# Production (only after the production release is approved):
wrangler d1 execute edenmish --remote --file=./migrations/016_driver_route_integrity.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('driver_routes')
WHERE name='plan_fingerprint';

SELECT name FROM sqlite_master
WHERE type='table' AND name='driver_location_samples';
```

---

### 017_driver_task_proofs.sql

**Purpose:** Stores photo/signature evidence separately for every assigned pickup
and drop-off task. Drop-off evidence is also mirrored to the existing customer
delivery-proof record so the tracking experience remains compatible.

**Commands:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote \
  --config wrangler.staging.generated.toml \
  --file=./migrations/017_driver_task_proofs.sql

# Production (only after the production release is approved):
wrangler d1 execute edenmish --remote --file=./migrations/017_driver_task_proofs.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name='driver_task_proofs';

SELECT name FROM pragma_index_list('driver_task_proofs')
WHERE name='idx_driver_task_proofs_order';
```

---

### 018_business_wallet.sql

**Purpose:** Adds passwordless business users/accounts, revocable account sessions,
prepaid wallets, Shopify top-up records, expiring credit lots, immutable ledger entries,
wallet reservations, plan enrollment history, and the delivery-order references needed
for wallet payment. It follows the driver-platform migrations `014`–`017`.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/018_business_wallet.sql

# Local verification:
wrangler d1 execute edenmish --local --file=./migrations/018_business_wallet.sql
# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote --file=./migrations/018_business_wallet.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name IN (
  'business_users','business_accounts','business_members','business_auth_challenges',
  'business_sessions','business_wallets','wallet_topups','wallet_credit_lots',
  'wallet_reservations','wallet_entries','business_plan_enrollments'
) ORDER BY name;

SELECT name FROM pragma_table_info('orders')
WHERE name IN ('business_account_id','wallet_reservation_id','payment_method');
```

---

## Full production migration checklist

- [ ] Confirm current branch is `main`.
- [ ] Pull latest `main` (`git pull --ff-only origin main`).
- [ ] Confirm target Cloudflare account.
- [ ] Confirm target D1 database is `edenmish`.
- [ ] Run `003_rate_limits.sql` if not already applied.
- [ ] Run `004_delivery_proofs.sql` if not already applied.
- [ ] Run `005_notifications.sql` if not already applied.
- [ ] Run `006_pod_signature.sql` if not already applied.
- [ ] Run `007_order_rating.sql` if not already applied.
- [ ] Run `008_coupons.sql` if not already applied.
- [ ] Run `009_invoice_tracking.sql` if not already applied.
- [ ] Run `010_order_service_schedule.sql` after merge and before deploying the Worker.
- [ ] Run `011_cancellation_requests.sql` after merge and before deploying the Worker.
- [ ] Run `014_driver_api_v1.sql` after merge and before enabling the driver app.
- [ ] Run `015_driver_route_tasks.sql` after 014 and before enabling mixed pickup/drop-off routes.
- [ ] Run `016_driver_route_integrity.sql` after 015 and before enabling GPS-origin route optimization.
- [ ] Run `017_driver_task_proofs.sql` after 016 and before enabling driver photo/signature capture.
- [ ] Run `018_business_wallet.sql` after merge and before deploying the Worker.
- [ ] Run verification queries (see each migration above).
- [ ] Confirm Worker secrets are set (see `README.md` → Secret checklist).
- [ ] Confirm Worker vars are set (see `wrangler.toml [vars]` + `ALLOWED_ORIGINS`).
- [ ] Deploy Worker **only after** migrations + secrets are ready.
- [ ] Smoke-test: order creation → tracking → ops → payment → delivery proof → notification audit.

---

## How to check applied migrations

There is **not yet a formal `applied_migrations` table**. For now, verify by checking
whether each table exists:

```sql
SELECT name FROM sqlite_master
WHERE type='table'
AND name IN ('rate_limits', 'delivery_proofs', 'notifications', 'coupons', 'coupon_redemptions', 'business_accounts', 'business_wallets', 'wallet_entries')
ORDER BY name;
```

A future migration system may add an `applied_migrations` tracking table. Do not implement
it in this PR.

---

## Planned future migrations

The following are **planned** but not yet implemented. See `docs/DATA_MODEL_V2.md` for
the full design.

- A future data-model migration — adds `customers`, `stops`, `route_plans`,
  `route_stops`, `status_events`, `applied_migrations` (additive, no destructive changes).
- Backfill + read/write-path migration will follow in separate PRs (PR13–PR15 per the plan).

Do not run these until they exist and have been validated on a dev DB.
