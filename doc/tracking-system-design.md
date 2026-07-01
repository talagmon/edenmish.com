# EdenMish — Delivery Tracking System (Plan A: custom on Cloudflare)

> **Status:** ✅ DEPLOYED (MVP) — `find.edenmish.com` + `ops.edenmish.com` live on Cloudflare Workers + D1.
> **Live URLs:** tracking `https://find.edenmish.com/t/:token` · ops `https://ops.edenmish.com` · create-order API `POST https://find.edenmish.com/api/orders`.
> **Ops PIN:** set as a Worker secret — `wrangler secret put OPS_PIN`. Not stored in this repo.
> **Pending secrets:** `PAYPLUS_API_KEY` + `RESEND_API_KEY` (payment links + email no-op until added).
> **Decision:** Built custom on **Cloudflare Workers + D1** (ownership, branded, no per-task fees). Onfleet remains a fallback.
> **Deploy creds:** Cloudflare OAuth (`wrangler login`) — account `2dd658a7839937523c0cca09eadce085`; D1 `edenmish` (`f2f51b54-0170-4594-a41c-7a6037c902aa`).

---

## Subdomains
- **`ops.edenmish.com`** — customer-facing **tracking page** (order status + live map + completion summary). Link format: `ops.edenmish.com/t/:token`.
- **`ops.edenmish.com/driver`** — Eden's **driver/ops page** (today's queue, status updates, GPS broadcast, complete-with-summary). PIN-protected.
- (Booking/marketing stays on `edenmish.com` — the Shopify funnel.)

## End-to-end flow
1. Customer submits the funnel form (or pays via Shopify/PayPlus) → **order created** in the Worker (D1) with a unique token.
2. Customer immediately gets the **tracking link** by email (+ WhatsApp if opted in): status `נתקבלה הבקשה`.
3. Eden sets the price (if dynamic) → customer pays a **PayPlus payment link** → status `שולם`. *(See payment fork below.)*
4. Eden opens `ops.edenmish.com/driver`, accepts the order, and drives:
   - `שליח בדרך לאיסוף` 🔴 (GPS live) → `נאסף` → `שליח בדרך אליך` 🔴 (GPS live).
5. On drop-off Eden taps **Delivered** → status `נמסר` ✅ → customer gets **completion summary** (pickup time, drop-off time, price).

## Status lifecycle (customer-visible)
`נתקבלה הבקשה` → `אושר מחיר` → `שולם` → `שליח בדרך לאיסוף` (🔴 live) → `נאסף` → `שליח בדרך אליך` (🔴 live) → `נמסר` ✅
Branches: `בוטל` / `נכשל (ניסיון מסירה)`.

## Components
- **Backend — Cloudflare Worker + D1:** `orders`, `status_history`, `gps_pings`; REST: create order, get order, update status, GPS ping, complete-with-summary; creates the PayPlus payment link; sends notifications.
- **Customer page** (`ops.edenmish.com`): status timeline, order details, **live map** (driver + pickup + drop-off + ETA) using the existing Google Maps key; completion summary view at delivery.
- **Driver page** (`ops.edenmish.com/driver`): queue, one-tap status buttons, auto GPS broadcast (wake-lock + high-accuracy) while en route, complete+summary form. PIN auth.
- **Notifications:** request-received (with link) → en-route (optional) → delivered (summary). Email always; WhatsApp if opted in (WhatsApp Cloud API on the business number).

## Edge cases to design for
- GPS temporarily lost → show "last seen X min ago" (driver page closed / phone asleep).
- No-answer at drop-off → `נכשל (ניסיון מסירה)` → re-attempt as a new leg.
- Customer cancellation / refund flow.
- WhatsApp opt-out → email only.
- Multiple orders simultaneously → driver queue (routing added later if needed).

---

## ❓ Open decisions (before build)
1. **Payment timing** — Option 1 quote→pay (dynamic pricing) vs Option 2 pay-first (fixed tiers)?
2. **WhatsApp notifications in v1** (needs Meta Cloud API setup), or **email-only first**?
3. **GPS scope** — live during the two en-route phases only (saves battery), or broader?
4. **Driver-page auth** — simple PIN, or stronger?
5. **Status set** — keep the 7 above, or simplify/expand?
