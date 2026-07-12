# Payment Modes

EdenMish supports multiple payment modes. **Do not implement new payment logic
unless the issue explicitly asks for it.** This file defines the modes and the
processor boundaries so future work stays clean.

> Boundary rule: **`worker/src/payment.js` is the only place charge logic lives.**
> Everything else calls `createCharge()` / `settleOrder()` and stays ignorant of
> the processor behind them.

---

## Processor boundaries (rules)

- **PayPlus is currently used ONLY through Shopify.** The PayPlus Shopify app is
  the gateway inside Shopify checkout. It handles card / Bit / Apple Pay / Google
  Pay / TIPS inside the Shopify checkout shell.
- **The Worker must NOT call PayPlus directly.** No PayPlus REST calls from the
  Worker, ever.
- **Mesh/J5 is a separate adapter, added later.** It will live behind the same
  `createCharge()` / `settleOrder()` boundary, switched on by `PAYMENT_MODE=preauth`
  + `MESH_API_KEY`. Nothing outside `payment.js` should know which processor ran.
- **`payment.js` must remain the clean payment boundary.** Do not leak processor
  details (Shopify draft URLs, Mesh hold refs, etc.) into routing/UI code beyond
  the generic `{ checkoutUrl, mode, processorRef }` shape it already returns.

---

## The five modes

### 1. `EXACT_CAPTURE` — known price, immediate capture *(target primary flow)*

- Price is **known** at order time (Worker pricing).
- Worker creates a **Shopify Draft Order** with the exact price.
- The booking funnel redirects directly to the Draft Order **`invoice_url`**.
- Customer pays through **Shopify checkout** (PayPlus app) → immediate capture.
- Shopify **`orders/paid` webhook** updates the internal order to `paid`.
- The booking response does not expose tracking. The tracking link is sent and the
  tracking API unlocks only after the signed paid webhook is reconciled.
- Maps to `payment_mode = 'immediate'` today.

### 2. `QUOTE_THEN_PAY` — price unknown, Eden quotes *(already used for review orders)*

- Order is **created first** (status `review`).
- Eden **approves/sets the price** in the ops dashboard.
- Worker creates a **Shopify Draft Order** payment link (`invoice_url`).
- Customer pays the invoice URL through Shopify + PayPlus.
- Webhook reconciles as above.
- Implemented today via the ops **"approve price"** action + `createDraftOrder`.

### 3. `PREAUTH_MAX_HOLD` — estimate now, capture actual later *(future — DO NOT IMPLEMENT YET)*

- Price is **estimated** but the final amount may change (e.g. after delivery).
- Customer **authorizes a maximum amount** up front.
- **Final amount is captured after delivery** (`settleOrder()`).
- **Unused hold is released** automatically.
- Will use **Mesh/J5** as the processor, behind `payment.js`.
- Requires `PAYMENT_MODE=preauth` + `MESH_API_KEY`. The order schema already has
  `payment_mode` + `authorized_amount` columns ready.
- **Blocked on `EXACT_CAPTURE` / `QUOTE_THEN_PAY` being stable first.** This is the
  last planned payment PR.

### 4. `BUSINESS_POSTPAID` — monthly/business billing *(future)*

- For repeat business clients on a monthly plan.
- No per-delivery charge at checkout; invoiced later.
- Not designed yet (needs a `customers`/`accounts` concept). Do not start.

### 5. `MANUAL` — fallback

- Eden handles the payment out of band (cash, manual transfer, etc.).
- The ops dashboard already has a **"mark paid manually"** action that sets
  `status = paid` + `payment_status = paid_manual` without touching any processor.
- Keep this as the always-available fallback; it must never call a payment API.

---

## Current vs target (at a glance)

| Mode | Status today | Path |
|---|---|---|
| `EXACT_CAPTURE` | ✅ implemented via Draft Orders with checkout-before-tracking | Path B |
| `QUOTE_THEN_PAY` | ✅ implemented via Draft Orders (ops "approve") | Path B |
| `PREAUTH_MAX_HOLD` | ⛔ stubbed only (`settleOrder` no-op, `MESH_API_KEY` unset) | future Mesh adapter |
| `BUSINESS_POSTPAID` | ⛔ not started | future |
| `MANUAL` | ✅ ops "mark paid manually" | fallback |

> The legacy cart/variant path (Path A) is retired for the EdenMish booking funnel.
> Do not reintroduce Shopify cart/catalog UX. See `ARCHITECTURE.md`.

## References

- `../worker/src/payment.js` — the boundary (`createCharge`, `settleOrder`).
- `../worker/src/integrations.js` — `createDraftOrder`, `verifyShopifyWebhook`, `parseShopifyOrderWebhook`.
- `../worker/src/index.js` — `/api/ops/orders/:id/approve` (Draft Order), `/webhooks/shopify` (reconcile).
- `../doc/payplus-setup.md` — Shopify + PayPlus + webhook setup steps.
