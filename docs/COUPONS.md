# Coupons

Discount codes for the booking funnel. **Coupons live entirely in the Worker's
D1 database — the ops dashboard is the management UI and the Worker is the
enforcement and pricing authority.** The customer never sends a price — the
Worker recomputes the subtotal, validates the code, applies the discount
server-side, and snapshots the result on the order. There is no external
lookup, sync, or cache: a code Eden creates is redeemable immediately.

```
   Ops dashboard (dash.html → קופונים)        Cloudflare Worker + D1
  ┌────────────────────────────────┐     ┌──────────────────────────────────────┐
  │  Create / edit / disable codes │ ──► │  /api/ops/coupons CRUD               │
  │  (percentage or fixed ₪)       │     │  → `coupons` table (source of truth) │
  └────────────────────────────────┘     │  validateCoupon reads D1 directly    │
                                         │  → authoritative price               │
                                         │  `coupon_redemptions` = usage counts │
                                         │  Draft Order uses final price       │
                                         │  mirrors the final price             │
                                         └──────────────────────────────────────┘
```

---

## Architecture

- **D1 = coupon management + source of truth.** Eden creates/edits/disables
  codes from the ops dashboard's קופונים tab (`storefront/public/dash.html`),
  which drives the `/api/ops/coupons` CRUD endpoints. Rows live in the D1
  `coupons` table (migration 008). Shopify is not involved in coupon
  management at all.
- **Worker = validation + authoritative pricing + redemption counts.**
  `validateCoupon` (`worker/src/coupons.js`) reads the code's definition
  straight from D1 — no external API call, no sync, no TTL — and validates it
  server-side against status, date window, and D1 redemption counts. The
  discount applies to the full Worker-computed price (incl. surcharges) and is
  clamped so the final price is never negative.
- **Order snapshot (migration 008).** `orders.price` is always the FINAL amount
  the customer pays; `subtotal_price`, `discount_code`, `discount_amount`, and
  `discount_title` record how we got there. One `coupon_redemptions` row is
  inserted per redeemed order — usage limits count these rows. For coupons with
  a usage limit (and/or once-per-customer), the redemption insert is an **atomic
  conditional insert** (`INSERT … SELECT … WHERE <count guards>`) so two
  concurrent orders can't both slip past the limit; the losing order is rejected
  with `usage_limit_reached` / `already_used` and its snapshot is cleared.
- **Ops re-price clears the coupon.** When Eden re-prices an order via the ops
  `/approve` endpoint, the manual price supersedes the coupon: the snapshot
  (`subtotal_price` / `discount_code` / `discount_amount` / `discount_title`)
  is cleared and the order's `coupon_redemptions` row is deleted, so the freed
  redemption can be used again and the new Draft Order carries the manual price.
- **Draft Order at checkout.** `createDraftOrder` (`worker/src/integrations.js`)
  sets the line item directly to the final (post-discount) price. The Shopify REST
  Admin API silently ignores `applied_discount` on Draft Order creation (it is a
  read-only field on that endpoint), so we never inflate + attach a discount.
  The discount breakdown is visible on the booking funnel, success page, tracking
  page, emails, and ops dashboard — only Shopify checkout omits it.
- **Money units** match `pricing.js`: integer whole shekels (ILS). Percentages
  are stored 0–100.

## Operator how-to (Eden)

1. Ops dashboard → tab **קופונים** → **קופון חדש**.
2. Fill in the fields:
   - **קוד קופון** — the code customers type (stored normalized UPPERCASE;
     read-only when editing an existing coupon).
   - **כותרת** — display name shown in the funnel, emails, and order views.
   - **סוג** — אחוז % (`percentage`, 0–100) or סכום קבוע ₪ (`fixed_amount`,
     whole shekels).
   - **ערך** — the percent or shekel amount (must be > 0).
   - **התחלה / סיום** (optional) — the validity window; outside it the code is
     rejected as `not_started` / `expired`.
   - **מגבלת שימוש** (optional) — total number of redemptions across all
     customers.
   - **הזן קוד פר לקוח** — once per customer (keyed by phone, falling back to
     email).
   - **סטטוס** — פעיל (`active`) / מושבת (`inactive`) / מתוזמן (`scheduled`);
     only `active` codes validate.
3. Save — the code is redeemable **immediately** (no sync delay).
4. Usage is shown live in the table (`מימוש` = redemptions / limit), counted
   from the D1 `coupon_redemptions` table.
5. **Delete is a soft-delete**: the row stays in D1 with `status = inactive`
   (so redemption history keeps its context) and the code stops validating.
   Re-activate it later by editing the coupon and setting the status back to
   פעיל.

## API endpoints

### Public (booking funnel)

| Endpoint | Purpose |
|---|---|
| `POST /api/coupons/validate` | Booking-funnel pre-check. Body: the same pricing inputs as `POST /api/orders` plus `coupon_code` (and `phone`/`email` for once-per-customer checks). Returns `{ valid: true, code, subtotal_price, discount_amount, price, title }` or `{ valid: false, reason, message }` (Hebrew `message` is what the UI shows). Rate-limited per hashed IP (10/min) so codes can't be brute-forced. |
| `POST /api/orders` with `coupon_code` | Validates again at order creation. An invalid code **rejects the order** (`400`, `error: 'invalid_coupon'`) — never silently created at full price. On success the response echoes `subtotal_price` / `discount_amount` / `discount_code` and the order row carries the snapshot. |

Rejection `reason` values: `not_found`, `unsupported`, `inactive`,
`not_started`, `expired`, `usage_limit_reached`, `already_used` (plus
`rate_limited` on the validate endpoint).

### Ops (session-authenticated, used by the dashboard)

| Endpoint | Purpose |
|---|---|
| `GET /api/ops/coupons` | List all coupons with their live `redemption_count` (from `coupon_redemptions`). |
| `POST /api/ops/coupons` | Create a coupon. Body: `code`, `title`, `value_type` (`percentage` \| `fixed_amount`), `value` (all required), plus optional `status` (default `active`), `starts_at`, `ends_at` (ms epoch), `usage_limit`, `applies_once_per_customer`. `409` if the code already exists, `400` on missing fields. |
| `PUT /api/ops/coupons/:code` | Partial update — only the fields present in the body change. `404` for an unknown code. The code itself is immutable. |
| `DELETE /api/ops/coupons/:code` | Soft-delete: sets `status = inactive` (the row and its redemption history are kept). `404` for an unknown code. |

## Where the discount is shown

- Booking funnel (`storefront/public/booking.html`) — live pre-check breakdown.
- Success page (`success.html`) — subtotal struck through + coupon line.
- Customer tracking (`track.html`) — "מחיר לפני הנחה" + "קופון" cells.
- Ops dashboard (`dash.html`) — mint coupon badge on cards; struck-through
  subtotal in the detail view; קופונים tab for management.
- Customer emails (payment confirmation, delivery summary) — "קופון CODE: −₪X"
  line under the price.

## Known limitation — 100% coupons produce a ₪0 Draft Order (needs live verification)

A 100% (or subtotal-covering fixed) coupon yields a final price of ₪0. The
Worker creates the Draft Order with a line item of ₪0.00. Whether Shopify
checkout + the PayPlus gateway complete a ₪0 invoice cleanly (and fire
`orders/paid`) has **not been verified live** — verify on the real shop before
promoting a 100% code.

## References

- `worker/src/coupons.js` — validation, CRUD, redemption recording.
- `worker/src/integrations.js` — `createDraftOrder` (final-price line item).
- `worker/migrations/008_coupons.sql` — `coupons`, `coupon_redemptions`, order snapshot columns.
- `FINAL_PRICING_SPEC.md` — the subtotal the discount applies to.
