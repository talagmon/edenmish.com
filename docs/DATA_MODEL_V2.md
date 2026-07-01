# EdenMish Data Model v2 Plan

> **Status:** PLANNING ONLY. This document defines the future normalized schema,
> migration/backfill strategy, and phased implementation PRs. **No schema, migration,
> or runtime code is changed by the PR that introduces this document.**

---

## 1. Why this is needed

The current `orders` table is a wide flat structure that works for the MVP. Every
customer field, pickup/drop-off address, package detail, status, payment reference,
and tracking token lives on a single row. This is fine when every delivery is a
simple A→B trip with one customer, one payment, and one status stream.

Future capabilities require normalization:

- **Multi-stop / return trips** — a flat `pickup` + `dropoff` cannot model a third
  stop, a return leg, or a "pickup on route" insertion.
- **Customer history** — without a `customers` table, repeat customers are invisible;
  every order re-enters name/phone/email. There is no way to see "all deliveries for
  this law firm."
- **Route planning** — dispatch and routing need ordered stop sequences decoupled from
  the order itself (`route_plans` + `route_stops`).
- **Richer status audit** — `status_history` records status + timestamp + note but not
  WHO changed it (customer vs. Eden vs. system) or the transition type.
- **Business accounts** — monthly-billed business clients need an account concept.
- **Migration discipline** — there is no `applied_migrations` table; the old `001`/`002`
  migrations overlap with `schema.sql` and can break fresh setups.

Production schema changes should be **phased, additive, and reversible**.

---

## 2. Current model summary

| Table | Owns | Notes |
|---|---|---|
| `orders` | Everything: customer details, pickup/drop-off flat fields, package, status, payment, dispatch, tracking token, email/OTP, timestamps | Wide table (~35 columns) |
| `status_history` | Append-only status log (`order_id`, `status`, `at`, `note`) | No actor / event type |
| `payments` | Payment records (`order_id`, `amount`, `payplus_id`, `status`, `url`, `paid_at`) | |
| `gps_pings` | Live tracking (`order_id`, `lat`, `lng`, `at`) | No driver / accuracy / heading |
| `delivery_proofs` | PoD (`order_id`, `receiver_name`, `delivery_note`, `photo_url`) | PR7; one row per order |
| `notifications` | Email audit (`order_id`, `channel`, `template`, `recipient`, `subject`, `status`, `provider_ref`, `error`) | PR8; per-order history supported (PR9) |
| `rate_limits` | OTP / order-creation throttling (`key`, `count`, `window_start`, `last_at`, `locked_until`) | PR5 |
| `pricing_rules` | Pricing config key-value (`base_envelope`, `per_km`, etc.) | |

### Current limitations

- **No `customers` table** — customer data is denormalized into every order.
- **No `stops` table** — pickup/drop-off are flat columns; cannot model multi-stop.
- **No `route_plans` / `route_stops`** — no dispatch or routing concept.
- **No clean business-account concept** — `customer_type` is a free-text field on `orders`.
- **No formal `applied_migrations` table** — verification is table-based (see `MIGRATIONS.md`).
- **`schema.sql` + older migrations (`001`/`002`) historically overlap** — `ALTER TABLE … ADD COLUMN` without `IF NOT EXISTS` can break fresh setups. `schema.sql` is the fresh-DB source of truth; numbered migrations are for existing production DBs.

---

## 3. Target tables

Planning level only. Column types and constraints will be finalized in the implementation PR.

### `customers`

**Purpose:** dedupe customer identity, support repeat customers, support business accounts later.

| Field | Notes |
|---|---|
| `id` | PK |
| `name` | |
| `phone` | soft match key |
| `email` | soft match key |
| `customer_type` | `private` / `business` |
| `company_name` | nullable (business accounts) |
| `created_at` | |
| `updated_at` | |

> Do not require perfect dedupe in v1. Use email/phone as soft matching keys. Preserve
> old order-level customer fields during transition (Phase 1–4).

### `orders` (evolved)

**Purpose:** keep the core delivery order, now with `customer_id` FK.

New/changed fields (additive):

| Field | Notes |
|---|---|
| `customer_id` | FK → `customers.id` (nullable during transition) |
| `dispatch_status` | extracted from the flat `status` concept |
| `cancelled_at` | timestamp |

> Do **not** remove old columns immediately (`name`, `phone`, `email`, `pickup`,
> `dropoff`, etc.). They remain as compatibility fallback until Phase 5 cutover.

### `stops`

**Purpose:** model pickup / drop-off / future multi-stop / return legs.

| Field | Notes |
|---|---|
| `id` | PK |
| `order_id` | FK → `orders.id` |
| `type` | `pickup` / `dropoff` / `return` / `extra_stop` |
| `sequence` | 1, 2, 3, … |
| `address` | |
| `address_detail` | floor / apartment / contact |
| `city` | used for zone pricing |
| `lat`, `lng` | |
| `contact_name` | nullable |
| `contact_phone` | nullable |
| `time_window_start`, `time_window_end` | nullable (future scheduling) |
| `completed_at` | when this stop was done |
| `created_at`, `updated_at` | |

**Backfill:** each existing order gets 2 stops (sequence 1 = pickup, sequence 2 = dropoff),
carrying over `pickup`/`dropoff`/`pickup_detail`/`dropoff_detail`/`pickup_lat`/`pickup_lng`/
`dropoff_lat`/`dropoff_lng`/`pickup_city`/`dropoff_city`.

### `route_plans`

**Purpose:** future dispatch/routing plan for one driver/day.

| Field | Notes |
|---|---|
| `id` | PK |
| `driver_name` | (no `drivers` table yet) |
| `date` | |
| `status` | `draft` / `active` / `completed` |
| `started_at`, `completed_at` | |
| `created_at`, `updated_at` | |

> Not required for MVP. Useful before route optimization. A `drivers` table may be
> added later if multi-driver support is needed (open question).

### `route_stops`

**Purpose:** order-independent route sequence within a plan.

| Field | Notes |
|---|---|
| `id` | PK |
| `route_plan_id` | FK → `route_plans.id` |
| `stop_id` | FK → `stops.id` |
| `planned_sequence` | intended order |
| `actual_sequence` | what actually happened |
| `eta` | nullable |
| `status` | `pending` / `arrived` / `completed` / `skipped` |
| `arrived_at`, `completed_at` | |
| `created_at`, `updated_at` | |

> Enables "insert a new pickup on an active route" logic later.

### `status_events`

**Purpose:** richer replacement for `status_history`.

| Field | Notes |
|---|---|
| `id` | PK |
| `order_id` | FK → `orders.id` |
| `old_status` | nullable (first event has no prior) |
| `new_status` | |
| `event_type` | `status_change` / `legacy_status_history` / `system` |
| `note` | carried over from `status_history.note` |
| `actor_type` | `customer` / `ops` / `system` / `webhook` |
| `actor_id` | nullable (ops session id, webhook ref, etc.) |
| `created_at` | |

**Backfill:** copy every `status_history` row into `status_events` with
`event_type = 'legacy_status_history'`, `new_status = status`, `note` carried over,
`actor_type = 'system'`. Keep `status_history` as a compatibility read fallback until
code switches.

### `notifications` (future improvements)

Already exists (PR8). Future additions:
- Capture SendGrid `X-Message-Id` as `provider_ref` (enhance `sendEmail` return shape).
- Add `whatsapp` channel rows when WhatsApp Business API is implemented.
- Add retry metadata (`retry_count`, `next_retry_at`).

### `gps_pings` (future improvements)

Already exists. Future additions: `driver_name` / `route_plan_id`, `accuracy`, `heading`,
`speed`.

### `payments` (future improvements)

Already exists. Future additions: Mesh/J5 authorization/capture/release fields, refund
records, better provider refs.

### `applied_migrations`

**Purpose:** track which migrations have been applied.

| Field | Notes |
|---|---|
| `id` | PK |
| `migration_name` | e.g. `006_data_model_v2_tables` |
| `checksum` | optional content hash for integrity |
| `applied_at` | epoch ms |

> Planning only. Do not implement in this PR.

---

## 4. Migration strategy

A safe, phased transition. Each phase is independently deployable and rollback-safe.

### Phase 1 — Additive schema only

Add new tables (`customers`, `stops`, `route_plans`, `route_stops`, `status_events`,
`applied_migrations`). **No destructive changes.** No column removal. Old tables and
columns remain untouched.

**Migration:** `006_data_model_v2_tables.sql` (idempotent `CREATE TABLE IF NOT EXISTS`).

### Phase 2 — Backfill

Populate the new tables from existing data:
- Create `customers` rows from `orders` (soft dedupe by email/phone).
- Create `stops` rows from `orders` (2 stops per order: pickup + dropoff).
- Copy `status_history` into `status_events`.
- Set `orders.customer_id` FK where a customer was created.
- Keep all old columns as-is (compatibility fallback).

**Deliverable:** a backfill script / admin-only Worker helper. Dev-DB validation first.
No production run unless explicitly approved.

### Phase 3 — Read-path compatibility layer

Update Worker code to **prefer** new tables when data exists:
- `getOrderById` joins `customers` + `stops` if `customer_id` / stop rows are present.
- Tracking page reads `stops` for address display when available.
- Ops dashboard reads `stops` when available.
- **Fallback** to old `orders` columns if new rows are missing (legacy orders not yet backfilled, or rollback).

No write-path changes yet. Old code paths still work.

### Phase 4 — Write-path dual-write

For **new** orders:
- Write old `orders` columns (as today) **AND** new `customers` / `stops` / `status_events` rows.
- `setOrderStatus` writes both `status_history` (legacy) and `status_events` (new).

This allows rollback: if new tables have issues, reads fall back to old columns.

### Phase 5 — Cutover

After production validation:
- Reads depend on the new model (`customers` / `stops` / `status_events`).
- Old columns become legacy (still populated, but no longer the primary read path).
- Do **not** remove old columns yet.

### Phase 6 — Cleanup (much later)

Only after real production stability (weeks/months):
- Consider removing legacy columns from `orders`.
- Not in the first Data Model v2 implementation.

---

## 5. Backfill plan

### Customers backfill

For each order:
1. Try to match an existing customer by `email` (exact) or `phone` (normalized).
2. If found → set `orders.customer_id`.
3. If not found → create a `customers` row, set `orders.customer_id`.
4. Log ambiguous cases (multiple customers matching the same email/phone) for manual review.

> Do not aggressively dedupe. Soft-match only. Err on the side of creating a new
> customer rather than merging two real people.

### Stops backfill

For each order:
1. Create a `stops` row: `type='pickup'`, `sequence=1`, carrying `pickup`, `pickup_detail`,
   `pickup_lat`, `pickup_lng`, `pickup_city`.
2. Create a `stops` row: `type='dropoff'`, `sequence=2`, carrying `dropoff`, `dropoff_detail`,
   `dropoff_lat`, `dropoff_lng`, `dropoff_city`.

### Status events backfill

For each `status_history` row:
1. Create a `status_events` row: `new_status = status_history.status`,
   `event_type = 'legacy_status_history'`, `note` carried over, `actor_type = 'system'`,
   `created_at = status_history.at`.

---

## 6. Compatibility plan

During the transition, all current product surfaces must continue to work:

| Surface | Requirement |
|---|---|
| Public funnel (`POST /api/orders`) | Still creates orders with old columns. Phase 4 adds dual-write. |
| Customer tracking (`find.edenmish.com`) | Reads old columns until Phase 3 adds stop/customer fallback. |
| Ops dashboard (`ops.edenmish.com`) | Same — reads old columns until Phase 3. |
| Payment / Draft Orders / webhook | Untouched by data-model changes. |
| Delivery proof | Untouched (already a separate table). |
| Notification audit | Untouched. |

**Rules:**
- No code should rely **only** on new tables until backfill is complete and validated.
- No destructive migration in the first implementation PR.
- Rollback should be possible by ignoring new tables (reads fall back to old columns).

---

## 7. Proposed implementation PRs

The actual schema + code work is split into small, independently-mergeable PRs:

### PR12 — Add Data Model v2 tables only

**Scope:** `schema.sql` + `migrations/006_data_model_v2_tables.sql` + `MIGRATIONS.md` update.
Tables: `customers`, `stops`, `route_plans`, `route_stops`, `status_events`, `applied_migrations`.
No runtime code changes.

### PR13 — Backfill script / admin-only migration helper

**Scope:** one script or Worker-local helper. Dev-DB validation first. No production run
unless explicitly approved. Backfills: customers, stops, status_events.

### PR14 — Read-path compatibility layer

**Scope:** `db.js` helpers, order serializers, tracking/ops read `stops`/`customers` when
available with fallback to old columns.

### PR15 — Write-path dual-write

**Scope:** new orders write old fields + new tables; `setOrderStatus` writes both
`status_history` + `status_events`. No old-column removal.

### PR16 — Route planning foundation

**Scope:** `route_plans` / `route_stops` usage (manual sequence, no optimization).
Depends on stops existing (PR12 + PR14).

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Migration mistakes (wrong column, missing FK) | Dev-DB validation before production; idempotent migrations; `applied_migrations` table for tracking. |
| Customer dedupe ambiguity (two people, same phone) | Soft-match only; log ambiguous cases; allow manual merge later. |
| Route complexity (overbuilding before volume justifies it) | `route_plans` deferred to PR16; manual sequence only; no optimization engine. |
| Old/new model drift during dual-write | Phase 4 dual-write keeps both in sync; Phase 5 cutover validates reads. |
| Performance with joins (stops + customers per order) | D1 handles simple joins well at this volume; add indexes if needed. |
| Rollback complexity | Phases 1–4 are fully rollback-safe (new tables ignored = old behavior). Phase 5+ requires conscious cutover. |
| Accidental destructive schema changes | `AGENTS.md` rule: no `DROP COLUMN` / `DROP TABLE` without explicit approval. |

---

## 9. Non-goals

This plan does **not** implement:

- Mesh/J5 preauth (`PREAUTH_MAX_HOLD`).
- WhatsApp Business API notifications.
- Route optimization / auto-dispatch.
- Multi-driver support (only `driver_name` text field for now).
- Automatic pricing rewrite.
- Removal of old `orders` columns.
- Production migration execution.

---

## 10. Open questions

1. **Customer dedupe aggressiveness** — should we match on phone alone, email alone,
   or require both? What happens with shared business phones?
2. **Business accounts** — should businesses become a separate `business_accounts` table
   with monthly-billing fields, or stay as `customer_type='business'` + `company_name`?
3. **Driver table** — do we need a `drivers` table before `route_plans`, or is
   `driver_name` text sufficient for a single-courier operation?
4. **Proof of delivery attachment** — should `delivery_proofs` attach to `orders` (today)
   or to the `dropoff` stop (future, when multi-stop)?
5. **Legacy field lifetime** — how long should old `orders` columns remain after
   cutover? (Suggested: until Phase 6, well after production stability.)
6. **`applied_migrations` management** — should it be handled by a script (auto-run
   on deploy) or manual D1 SQL (operator runs each migration and records it)?
