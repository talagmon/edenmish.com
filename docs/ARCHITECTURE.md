# Architecture

EdenMish is a **mixed stack**: a Shopify theme as the public storefront/funnel,
and a **Cloudflare Worker + D1** as the delivery-ops backend and **source of
truth**. There is no separate app server; the Worker also serves the customer
tracking page and the ops dashboard as server-rendered HTML.

```
            edenmish.com (Shopify)                 find.edenmish.com / ops.edenmish.com
   ┌──────────────────────────────┐          ┌─────────────────────────────────────────┐
   │  Homepage funnel (Hebrew/RTL)│          │  Cloudflare Worker  (worker/src)         │
   │  SEO + policy pages          │  ──────► │   • POST /api/orders  (create order)     │
   │  Checkout shell              │  webhook │   • /t/:token  (tracking page)           │
   │  PayPlus app = gateway       │  ◄────── │   • ops dashboard (PIN)                  │
   └──────────────────────────────┘  paid    │   • /webhooks/shopify (HMAC-verified)    │
                                              │  D1 (SQLite): orders, status_history,    │
                                              │   gps_pings, payments, pricing_rules     │
                                              └─────────────────────────────────────────┘
```

---

## Shopify — what it owns

Shopify is the **storefront and the trusted checkout/payment shell**.

- **Homepage / funnel entry** — the `eden-funnel` section is the only section on
  the homepage (`templates/index.json`).
- **SEO pages** — Shopify handles indexing, sitemap, meta.
- **Policy pages** — Terms, Refund/Cancellation, Privacy (drafted in `doc/policies/`).
- **Funnel host** — the delivery request form (`sections/eden-funnel.liquid`).
- **Trusted checkout shell** — card / Bit / Apple Pay / Google Pay happen inside
  Shopify checkout.
- **PayPlus gateway** — the PayPlus Shopify app is the payment processor *inside*
  Shopify checkout. PayPlus is **never** called directly by the Worker.

## Shopify — what it must NOT own

- Delivery order source of truth
- Order queue / dispatch
- Tracking page / live map
- Routing
- Status lifecycle
- Live GPS
- Payment reconciliation logic

> Shopify is a shell, not the system of record. The Worker + D1 is.

## Worker + D1 — what it owns (source of truth)

Implemented in `worker/src/`:

- **Order creation** — `POST /api/orders` → `createOrder` writes the `orders` row.
- **Pricing and quotes** — `pricing.js#priceOrder` is the single calculation source for `GET/POST /api/quote`, coupon validation, and order creation. It reads current D1 `pricing_rules`; the funnel keeps only a disclosed minimum-price fallback for temporary network failure.
- **Payment mode selection** — `payment.js` chooses `immediate` (today) vs `preauth` (future Mesh).
- **Tracking token** — 22-hex unguessable token, generated on order creation.
- **Customer tracking page** — `find.edenmish.com/t/:token`, OTP-gated, live map.
- **Ops dashboard** — `ops.edenmish.com`, PIN login, status stepper, GPS broadcast.
- **Status history** — append-only `status_history` on every status change.
- **GPS pings** — `gps_pings` written from the ops dashboard during live legs.
- **Shopify webhook handling** — `POST /webhooks/shopify`, HMAC-verified, reconciles `orders/paid`.
- **Coupon management, validation & redemption** — codes are managed D1-only from the ops dashboard (`/api/ops/coupons` CRUD); the Worker validates them straight from D1, applies the discount to its own computed price, and counts redemptions in D1 (`coupon_redemptions` is authoritative). See `COUPONS.md`.
- **Future Mesh/J5 webhook handling** — payment boundary already stubbed (`payment_mode`, `authorized_amount`, `settleOrder`).

---

## Known architecture issue — two payment paths (to be resolved)

Today there are **two competing ways a customer pays**, and they contradict the
target architecture. **Do not extend the legacy path.**

### Path A — Cart / variant checkout (legacy, to be retired)

- The funnel adds a **product variant** to the Shopify cart (Storefront API or
  `/cart/add.js`) and redirects to `/checkout`.
- The price surcharge is modeled as the **quantity of a hidden 1-₪ "surcharge
  variant"** — fragile.
- The **Worker is NOT the source of truth for the charge** until the webhook fires.
- Relies on the product catalog / cart / variant UX that the architecture rejects.

### Path B — Draft Order (target for Shopify/PayPlus payments)

- The Worker creates a Shopify **Draft Order** via Admin API (`createDraftOrder`)
  carrying the Worker-computed price.
- The customer pays the Draft Order's **`invoice_url`** through Shopify checkout
  (PayPlus app).
- The Worker **is** the source of truth for the charge from creation.
- Used today only for **review orders** (ops "approve price"). This is the path to
  standardize on for `EXACT_CAPTURE` and `QUOTE_THEN_PAY`.

### Target

Standardize on **Draft Orders only** (Path B) for all Shopify/PayPlus payments.
Retire Path A. The webhook handler already recovers the token from both paths, so
the migration is incremental. See `PAYMENT_MODES.md` for the mode definitions and
`STATUS_MODEL.md` for the lifecycle.

> Migration to Draft-Order-only is **a separate PR** (the "Funnel → Draft Order
> payment" PR). Do not start it from this doc.

---

## References

- `PAYMENT_MODES.md` — the five payment modes and processor boundaries.
- `COUPONS.md` — discount codes: ops-dashboard management, Worker/D1 enforcement.
- `STATUS_MODEL.md` — current statuses, future normalized model, queue buckets.
- `ENVIRONMENT.md` — secrets, vars, and Shopify/theme settings.
- `../worker/README.md` — Worker files, commands, D1, secret/webhook checklists.
- `../doc/tracking-system-design.md` — original design notes (deployed MVP).
- `../doc/payplus-setup.md` — Shopify + PayPlus + webhook setup steps.
