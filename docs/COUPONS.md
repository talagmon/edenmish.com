# Coupons

Discount codes for the booking funnel. **Shopify Admin is the coupon management
UI; the Worker + D1 is the enforcement and pricing authority.** The customer
never sends a price — the Worker recomputes the subtotal, validates the code,
applies the discount server-side, and snapshots the result on the order.

```
   Shopify Admin (create/edit codes)          Cloudflare Worker + D1
  ┌────────────────────────────────┐     ┌──────────────────────────────────────┐
  │  Discounts → "Amount off order"│ ──► │  fetchShopifyDiscountByCode (GraphQL)│
  │  (Basic code discounts only)   │sync │  → `coupons` table (10-min TTL,      │
  └────────────────────────────────┘     │     stale-while-error)               │
                                         │  validateCoupon → authoritative price│
                                         │  `coupon_redemptions` = usage counts │
                                         │  Draft Order applied_discount        │
                                         └──────────────────────────────────────┘
```

---

## Architecture

- **Shopify Admin = coupon management.** Eden creates/edits/disables codes in
  Shopify Admin → Discounts. No coupon editing UI exists in the ops dashboard.
- **Worker/D1 = validation + authoritative pricing + redemption counts.**
  `worker/src/coupons.js` syncs each code's definition into the D1 `coupons`
  table (10-minute TTL, stale-while-error if Shopify is unreachable) and
  validates it server-side against status, date window, and D1 redemption
  counts. The discount applies to the full Worker-computed price (incl.
  surcharges) and is clamped so the final price is never negative.
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
  redemption can be used again and the new Draft Order carries no
  `applied_discount`.
- **Draft Order `applied_discount` at checkout.** `createDraftOrder`
  (`worker/src/integrations.js`) keeps the line item at the original subtotal
  and attaches the discount as Shopify's `applied_discount` — always
  `fixed_amount`, even for percentage coupons, so the Shopify checkout total is
  exactly the Worker's integer-shekel price with no re-rounding drift.
- **Money units** match `pricing.js`: integer whole shekels (ILS). Percentages
  are stored 0–100.

## Required Shopify Admin API scope

The Worker's custom-app token (`SHOPIFY_ADMIN_TOKEN`) needs the
**`read_discounts`** scope (in addition to the Draft Order scopes) for the
GraphQL `codeDiscountNodeByCode` lookup. Grant it in Shopify Admin → Settings →
Apps and sales channels → Develop apps → *your app* → API scopes.

## Operator how-to (Eden)

1. Shopify Admin → **Discounts** → **Create discount** → **Amount off order**
   (a "Basic" discount code — this is the only supported kind).
2. Choose **amount off** (fixed ₪) or **percentage**.
3. Set usage limits there if wanted: *total number of uses* and/or *one use per
   customer*. The Worker enforces both from D1 redemption counts (per code, and
   per code + phone/email for once-per-customer).
4. Active dates / deactivation in Shopify are honored (up to the 10-minute sync
   TTL).

**Not supported** (rejected as invalid at validation): Buy X Get Y, free
shipping, and app-provided discounts. Only Basic code discounts with an
amount-off or percentage value work.

## API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/coupons/validate` | Booking-funnel pre-check. Body: the same pricing inputs as `POST /api/orders` plus `coupon_code` (and `phone`/`email` for once-per-customer checks). Returns `{ valid: true, code, subtotal_price, discount_amount, price, title }` or `{ valid: false, reason, message }` (Hebrew `message` is what the UI shows). Rate-limited per hashed IP (10/min) so codes can't be brute-forced. |
| `POST /api/orders` with `coupon_code` | Validates again at order creation. An invalid code **rejects the order** (`400`, `error: 'invalid_coupon'`) — never silently created at full price. On success the response echoes `subtotal_price` / `discount_amount` / `discount_code` and the order row carries the snapshot. |

Rejection `reason` values: `not_found`, `unsupported`, `inactive`,
`not_started`, `expired`, `usage_limit_reached`, `already_used` (plus
`rate_limited` on the validate endpoint).

## Where the discount is shown

- Booking funnel (`storefront/public/booking.html`) — live pre-check breakdown.
- Success page (`success.html`) — subtotal struck through + coupon line.
- Customer tracking (`track.html`) — "מחיר לפני הנחה" + "קופון" cells.
- Ops dashboard (`dash.html`) — mint coupon badge on cards; struck-through
  subtotal in the detail view.
- Customer emails (payment confirmation, delivery summary) — "קופון CODE: −₪X"
  line under the price.

## Known limitation — 100% coupons produce a ₪0 Draft Order (needs live verification)

A 100% (or subtotal-covering fixed) coupon yields a final price of ₪0. The
Worker still creates the Draft Order with the line item at the original
subtotal and an `applied_discount` for the full amount, i.e. a **zero-total
Draft Order invoice**. Whether Shopify checkout + the PayPlus gateway complete
a ₪0 invoice cleanly (and fire `orders/paid`) has **not been verified live** —
verify on the real shop before promoting a 100% code. (Unit tests only cover
the payload shape; no payment logic was changed for this.)

## Known limitation — Shopify's usage counter does not increment

The customer pays a **Draft Order** with `applied_discount`, not a checkout
where the code was typed in — so Shopify's own "Used X times" counter for the
discount **never increments**. The D1 `coupon_redemptions` table is the
authoritative usage count and is what usage limits are enforced against. Don't
be confused by Shopify Admin showing 0 uses.

## References

- `worker/src/coupons.js` — sync + validation + redemption recording.
- `worker/src/integrations.js` — `fetchShopifyDiscountByCode`, `createDraftOrder`.
- `worker/migrations/008_coupons.sql` — `coupons`, `coupon_redemptions`, order snapshot columns.
- `ENVIRONMENT.md` — `SHOPIFY_ADMIN_TOKEN` (+ `read_discounts` scope).
- `FINAL_PRICING_SPEC.md` — the subtotal the discount applies to.
