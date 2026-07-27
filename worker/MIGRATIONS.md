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

### 024_phone_delivery_link_consent.sql

**Purpose:** Stores the customer's optional, explicit consent to receive the
proof-of-delivery link through WhatsApp in addition to the primary SendGrid email.
The consent timestamp is stored with the order and checked again when the outbox job
is delivered.

**Command:**
```bash
wrangler d1 execute edenmish --remote --file=./migrations/024_phone_delivery_link_consent.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('orders')
WHERE name IN ('phone_delivery_link_opt_in','phone_delivery_link_opt_in_at');
```

---

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

### 019_delivery_notification_outbox.sql

**Purpose:** Makes driver delivery completion atomic with a durable transition marker
and one unique customer-notification job per channel. Jobs use expiring leases, bounded
exponential retries, and terminal `sent`/`dead` states. Provider delivery is
**at-least-once**: a Worker crash after provider acceptance but before the `sent` update
can cause another attempt.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/019_delivery_notification_outbox.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/019_delivery_notification_outbox.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/019_delivery_notification_outbox.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name IN (
  'delivery_completion_transitions','delivery_notification_outbox'
) ORDER BY name;

SELECT name FROM pragma_index_list('delivery_notification_outbox')
WHERE name='idx_delivery_notification_outbox_due';

SELECT state, COUNT(*) FROM delivery_notification_outbox GROUP BY state;
```

---

### 020_business_wallet_schema_repair.sql

**Purpose:** Repairs a partially applied migration 018 without rerunning its
non-idempotent `ALTER TABLE orders` statements. It recreates every missing wallet
table and index with `IF NOT EXISTS` and is safe to run repeatedly after the three
business-wallet columns exist on `orders`.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/020_business_wallet_schema_repair.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/020_business_wallet_schema_repair.sql

# Production: run only if migration 018 readiness is incomplete, before Worker deploy.
wrangler d1 execute edenmish --remote \
  --file=./migrations/020_business_wallet_schema_repair.sql
```

**Verification query:**
```sql
SELECT COUNT(*) AS tables FROM sqlite_master
WHERE type='table' AND name IN (
  'business_users','business_accounts','business_members','business_auth_challenges',
  'business_sessions','business_wallets','wallet_topups','wallet_credit_lots',
  'wallet_reservations','wallet_entries','business_plan_enrollments'
);

SELECT COUNT(*) AS columns FROM pragma_table_info('orders')
WHERE name IN ('business_account_id','wallet_reservation_id','payment_method');
```

Expected result: `tables = 11` and `columns = 3`.

---

### 021_business_entry_plans.sql

**Purpose:** Promotes the ₪150 Trial package and ₪1,500 Business Wallet to
first-class business-account plans. It rebuilds the three tables whose plan ID
checks previously allowed only Silver, Gold, and Platinum, preserves existing
accounts/top-ups/enrollments, and adds a unique guard for one active or paid Trial
purchase per business account.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/021_business_entry_plans.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/021_business_entry_plans.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/021_business_entry_plans.sql
```

**Verification query:**
```sql
SELECT name, sql FROM sqlite_master
WHERE type='table' AND name IN (
  'business_accounts','wallet_topups','business_plan_enrollments'
)
ORDER BY name;

SELECT name FROM pragma_index_list('wallet_topups')
WHERE name='idx_wallet_topups_trial_once';

PRAGMA foreign_key_check;
```

Expected result: all three table definitions include `trial` and `wallet`, the
Trial guard index exists, and `foreign_key_check` returns no rows.

---

### 022_business_plan_coupons.sql

**Purpose:** Adds coupon scope and optional plan targeting, stores the discounted
payment separately from the full wallet-credit amount, and records business coupon
redemptions against wallet top-ups. A ₪150 package therefore remains ₪150 of credit
even when the Shopify payment is reduced by a coupon.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/022_business_plan_coupons.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/022_business_plan_coupons.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/022_business_plan_coupons.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('coupons')
WHERE name IN ('scope','business_plan_ids');
SELECT name FROM pragma_table_info('wallet_topups')
WHERE name IN ('payment_amount_agorot','discount_code','discount_amount_agorot','discount_title');
SELECT name FROM sqlite_master
WHERE type='table' AND name='business_coupon_redemptions';
```

Expected result: two coupon columns, four top-up payment snapshot columns, and the
business redemption table.

---

### 023_driver_login_invitations.sql

**Purpose:** Adds per-driver, expiring login invitations used by the Ops dashboard
for manual-code and QR pairing. Only an HMAC of the code is stored. Each invitation
is bound to one active driver, expires after 5–60 minutes, and can be consumed once
or explicitly revoked.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/023_driver_login_invitations.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/023_driver_login_invitations.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/023_driver_login_invitations.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name='driver_login_invitations';
SELECT name FROM sqlite_master
WHERE type='index' AND name IN (
  'idx_driver_login_invitations_driver',
  'idx_driver_login_invitations_active'
)
ORDER BY name;
```

Expected result: one table and both indexes. The table must contain `code_hash`
and must not contain a raw `code` column.

---

### 025_delivery_failure_retained_package.sql

**Purpose:** Records when a failed delivery leaves the physical package with the
driver, together with the timestamp used by the 24-hour auto-return rule. The
partial index keeps retained-package dispatch lookups bounded without changing the
shared order-status vocabulary.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/025_delivery_failure_retained_package.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/025_delivery_failure_retained_package.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/025_delivery_failure_retained_package.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('orders')
WHERE name IN ('retained_by_driver','retained_at')
ORDER BY name;
SELECT name FROM sqlite_master
WHERE type='index' AND name='idx_orders_retained_by_driver';
```

Expected result: both order columns and the retained-package partial index.

---

### 026_redelivery_pending_address.sql

**Purpose:** Stages the package owner's corrected redelivery destination and
quoted fee without overwriting the failed address. Ops promotes the staged data
only after payment is confirmed.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/026_redelivery_pending_address.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/026_redelivery_pending_address.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/026_redelivery_pending_address.sql
```

**Verification query:**
```sql
SELECT name FROM pragma_table_info('orders')
WHERE name='pending_redelivery_json';
```

Expected result: the `pending_redelivery_json` order column.

---

### 027_retained_failure_notifications.sql

**Purpose:** Expands the durable delivery outbox with the
`delivery_failed_retained` transition used for customer failure emails. SQLite
cannot alter the transition `CHECK` in place, so this migration rebuilds the
outbox table while preserving all delivered-notification jobs, retry counts,
leases, errors, and sent timestamps.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/027_retained_failure_notifications.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/027_retained_failure_notifications.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/027_retained_failure_notifications.sql
```

**Verification query:**
```sql
SELECT sql FROM sqlite_master
WHERE type='table' AND name='delivery_notification_outbox';

SELECT transition, state, COUNT(*)
FROM delivery_notification_outbox
GROUP BY transition, state
ORDER BY transition, state;

SELECT name FROM pragma_index_list('delivery_notification_outbox')
WHERE name='idx_delivery_notification_outbox_due';
```

Expected result: the table definition permits both `delivered` and
`delivery_failed_retained`, all pre-migration jobs remain present in their original
states, and the due-job index exists.

---

### 028_redelivery_charges.sql

**Purpose:** Adds the purpose-specific redelivery charge ledger. A corrected-address
retry fee gets its own immutable amount, Shopify Draft Order reference, expiry, and
webhook reconciliation state instead of overwriting the original delivery payment.

**Command:**
```bash
# Staging (render the config first; run from worker/):
npx wrangler d1 execute edenmish-staging --remote --yes \
  --config wrangler.staging.generated.toml \
  --file=./migrations/028_redelivery_charges.sql

# Local verification:
wrangler d1 execute edenmish --local \
  --file=./migrations/028_redelivery_charges.sql

# Production (after merge, before Worker deploy):
wrangler d1 execute edenmish --remote \
  --file=./migrations/028_redelivery_charges.sql
```

**Verification query:**
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name='redelivery_charges';

SELECT name FROM pragma_index_list('redelivery_charges')
WHERE name='idx_redelivery_charges_status';

SELECT status, COUNT(*)
FROM redelivery_charges
GROUP BY status
ORDER BY status;
```

Expected result: the table and status/expiry index exist. Before the feature is used,
the grouped status query may return no rows.

---

### 029_wallet_reservation_ownership.sql

**Purpose:** Enforces the payment invariant that one non-null wallet reservation
can fund exactly one delivery order. This closes a concurrent same-idempotency-key
race in the business order API.

**Preflight (must return zero rows):**
```sql
SELECT wallet_reservation_id, COUNT(*) AS order_count
FROM orders
WHERE wallet_reservation_id IS NOT NULL
GROUP BY wallet_reservation_id
HAVING COUNT(*) > 1;
```

If this query returns any rows, stop and review the affected orders and wallet
ledger entries manually. The migration deliberately refuses to guess which
payment record is authoritative.

**Command:**
```bash
wrangler d1 execute edenmish --remote --file=./migrations/029_wallet_reservation_ownership.sql
```

**Verification query:**
```sql
SELECT name, sql FROM sqlite_master
WHERE type = 'index' AND name = 'idx_orders_wallet_reservation_unique';
```

---

### 030_whatsapp_template_delivery_audit.sql

**Purpose:** Adds durable paid-order WhatsApp jobs, sanitized provider lifecycle
status, and a unique provider-reference index for idempotent delivery receipts.
It expands the existing outbox transition constraint without losing queued,
processing, sent, or dead jobs.

**Preflight (must return zero rows):**
```sql
SELECT provider_ref, COUNT(*) AS notification_count
FROM notifications
WHERE provider_ref IS NOT NULL
GROUP BY provider_ref
HAVING COUNT(*) > 1;
```

If this returns rows, stop and reconcile the duplicate provider references. Do
not guess which notification record is authoritative.

**Command:**
```bash
wrangler d1 execute edenmish --remote \
  --file=./migrations/030_whatsapp_template_delivery_audit.sql
```

**Verification queries:**
```sql
SELECT name FROM pragma_table_info('notifications')
WHERE name IN ('provider_status','provider_updated_at')
ORDER BY name;

SELECT name, sql FROM sqlite_master
WHERE type='index' AND name='idx_notifications_provider_ref';

SELECT name FROM pragma_table_info('delivery_notification_outbox')
WHERE name IN ('provider_ref','provider_status','provider_updated_at')
ORDER BY name;

SELECT name, sql FROM sqlite_master
WHERE type='index'
  AND name='idx_delivery_notification_outbox_provider_ref';

SELECT sql FROM sqlite_master
WHERE type='table' AND name='delivery_notification_outbox'
  AND sql LIKE '%payment_received%';
```

Expected: two notification columns, three outbox provider-audit columns, both
unique partial provider-reference indexes, and an outbox table constraint that
permits `payment_received`.

---

### 031_first_delivery_promotion.sql

**Purpose:** Adds ops-managed automatic first-delivery coupon fields and an
atomic eligibility-claim table. Claims are keyed by normalized phone, normalized
email, and (when present) the authenticated business account. The migration also
creates the 10% launch offer ending at epoch ms `1788209999999`, which is
31 August 2026 at 23:59:59.999 in Israel.

**Command:**
```bash
wrangler d1 execute edenmish --remote \
  --file=./migrations/031_first_delivery_promotion.sql
```

**Verification queries:**
```sql
SELECT name FROM pragma_table_info('coupons')
WHERE name IN ('auto_apply','eligibility_rule')
ORDER BY name;

SELECT name FROM sqlite_master
WHERE type='table' AND name='first_delivery_promotion_claims';

SELECT name FROM sqlite_master
WHERE type='index' AND name IN (
  'idx_coupon_redemptions_promotion_claim',
  'idx_first_delivery_claim_phone',
  'idx_first_delivery_claim_email',
  'idx_first_delivery_claim_business',
  'idx_first_delivery_claim_business_idempotency'
)
ORDER BY name;

SELECT code, value_type, value, auto_apply, eligibility_rule, scope,
       applies_once_per_customer, ends_at
FROM coupons
WHERE code='FIRST10-2026';
```

Expected: both coupon columns, the claim table, all five unique claim/redemption
indexes, and one active delivery coupon with `value=10`, `auto_apply=1`,
`eligibility_rule='first_delivery'`, `applies_once_per_customer=1`, and
`ends_at=1788209999999`.

---

### 032_analytics_conversion_claims.sql

**Purpose:** Adds a short-lived, one-time bridge between an explicitly consented
browser session and the existing verified Shopify paid-order transition. Only a
SHA-256 claim hash, order foreign key, lifecycle timestamps, and the
`emitted`/`suppressed` disposition are stored. The table contains no raw browser
credential, customer/contact/address data, tracking token, Shopify identifier, or
analytics-provider identifier.

The Worker code that settles these claims is intentionally migration-dependent.
Run this migration after merge and **before deploying that Worker version**.

**Production command:**
```bash
wrangler d1 execute edenmish --remote \
  --file=./migrations/032_analytics_conversion_claims.sql
```

**Verification queries:**
```sql
SELECT name, type FROM sqlite_master
WHERE name IN (
  'analytics_conversion_claims',
  'idx_analytics_conversion_claim_expiry'
)
ORDER BY type, name;

SELECT name, type, "notnull", pk
FROM pragma_table_info('analytics_conversion_claims')
ORDER BY cid;
```

Expected: one table, one expiry index, and exactly these columns:
`claim_hash`, `order_id`, `disposition`, `created_at`, `expires_at`,
`settled_at`, and `observed_at`.

Claims expire after seven days. The daily Worker cleanup deletes expired claims
and observed claims after a maximum of 30 days. Core order/payment retention is
unchanged.

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
- [ ] Run `019_delivery_notification_outbox.sql` after 018 and before enabling native driver completion.
- [ ] Run `020_business_wallet_schema_repair.sql` only when migration 018 readiness is incomplete.
- [ ] Run `021_business_entry_plans.sql` after 018/020 and before enabling Trial or Business Wallet checkout.
- [ ] Run `022_business_plan_coupons.sql` after 021 and before enabling business-plan coupons.
- [ ] Run `023_driver_login_invitations.sql` after 014 and before enabling Ops driver pairing.
- [ ] Run `024_phone_delivery_link_consent.sql` before enabling phone delivery-link consent.
- [ ] Run `025_delivery_failure_retained_package.sql` before accepting retained-package dispositions.
- [ ] Run `026_redelivery_pending_address.sql` after 025 and before enabling corrected-address redelivery.
- [ ] Run `027_retained_failure_notifications.sql` after 019 and before enabling retained-package customer emails.
- [ ] Run `028_redelivery_charges.sql` after 026 and before enabling corrected-address redelivery payments.
- [ ] Run `029_wallet_reservation_ownership.sql` after the duplicate-reference preflight and before deploying the Worker.
- [ ] Run `030_whatsapp_template_delivery_audit.sql` after its duplicate-provider-reference preflight and before deploying WhatsApp hardening.
- [ ] Run `031_first_delivery_promotion.sql` after merge and before deploying the first-delivery promotion.
- [ ] Run `032_analytics_conversion_claims.sql` after merge and before deploying the paid-conversion Worker.
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
AND name IN ('rate_limits', 'delivery_proofs', 'notifications', 'coupons', 'coupon_redemptions', 'business_accounts', 'business_wallets', 'wallet_entries', 'delivery_completion_transitions', 'delivery_notification_outbox')
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
