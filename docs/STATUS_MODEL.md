# Status Model

This documents the **current** status values actually used in the code, then
proposes a **future normalized** model. The future model remains a target for a
later, scoped PR.

> Current values are a **free-text enum** on `orders.status`. There is no DB
> constraint enforcing them. Both UIs (`pages.js`) hardcode the value→label maps.

---

## Current statuses (as found in the audit)

Source of truth: `worker/src/pages.js` (HE label map + tracking FLOW), plus
`worker/src/index.js` (statuses written by handlers).

| Status (DB) | Hebrew label (ops) | Meaning | Written by |
|---|---|---|---|
| `received` | נתקבלה | Request received (default) | `createOrder` |
| `priced` | מחושב אוטומטית | Auto-priced, no exceptions | `createOrder` (non-review) |
| `review` | בדיקה ידנית | Flagged for manual price review | `createOrder` (review) |
| `payment_sent` | קישור תשלום נשלח | Draft Order invoice URL sent to customer | ops "approve" |
| `paid` | שולם | Payment captured (webhook or manual) | webhook / ops |
| `to_pickup` | בדרך לאיסוף | Courier en route to pickup (**live GPS**) | ops stepper |
| `picked_up` | נאסף | Package picked up | ops stepper |
| `to_dropoff` | בדרך למסירה | Courier en route to drop-off (**live GPS**) | ops stepper |
| `delivered` | נמסר | Delivered (writes `delivered_at`, sends summary email) | ops stepper |
| `failed` | נכשל | Delivery attempt failed | ops "mark failed" |
| `cancelled` | בוטל | Cancelled, including a confirmed full refund | manual / Shopify webhook |
| `refund_pending` | ממתין לזיכוי | Refund pending, partial, failed, or under review | Shopify webhook |

### Current customer-visible lifecycle (tracking page `FLOW`)

```
received → priced → payment_sent → paid → to_pickup → picked_up → to_dropoff → delivered
```

- `review` is shown separately on the tracking page ("בדיקה ידנית — עדן יאשר מחיר בקרוב").
- Live GPS map renders only during `to_pickup` and `to_dropoff`.
- Branches: `failed` / `cancelled` / `refund_pending`.

### Current ops stepper (`STEPS`, normalized to 6 steps)

```
priced/paid → paid → to_pickup → picked_up → to_dropoff → delivered
```

The stepper collapses `received`/`priced`/`review`/`payment_sent` into step 0
("ממתין לתשלום…"), then `paid`=1, `to_pickup`=2, `picked_up`=3, `to_dropoff`=4,
`delivered`=5.

### Known muddiness in the current model

- `priced` (auto) vs `review` (manual) vs `payment_sent` (link sent) overlap
  conceptually — they are all pre-payment states with slightly different meanings.
- No explicit `confirmed`/`assigned` state between `paid` and `to_pickup`
  (a paid order waiting to be dispatched is indistinguishable from a paid order
  about to leave).
- No `arrived_at_pickup` / `arrived_at_dropoff` granularity.
- There is no separate delivery-status value for `refunded`: a confirmed full
  refund uses terminal delivery status `cancelled` and `payment_status = refunded`.
- Values are free text → typos won't be caught by the DB.

---

## Future normalized model (PROPOSAL — do not implement in this PR)

A cleaner enum with explicit pre-dispatch, arrival, and terminal states. Target
for a dedicated status-normalization PR (would add a shared `status.js` map used
by both UIs, and ideally a DB check constraint).

| Status | Meaning | Live GPS? | Terminal? |
|---|---|---|---|
| `REQUESTED` | Order created, awaiting price/payment flow | no | no |
| `QUOTED` | Price computed/set, awaiting payment | no | no |
| `PAYMENT_PENDING` | Payment link sent, not yet paid | no | no |
| `PAID` | Payment captured | no | no |
| `ASSIGNED` | Assigned to a courier, not yet moving | no | no |
| `EN_ROUTE_TO_PICKUP` | Courier heading to pickup | **yes** | no |
| `ARRIVED_AT_PICKUP` | Courier at pickup location | yes | no |
| `PICKED_UP` | Package in hand | no | no |
| `EN_ROUTE_TO_DROPOFF` | Courier heading to drop-off | **yes** | no |
| `ARRIVED_AT_DROPOFF` | Courier at drop-off location | yes | no |
| `DELIVERED` | Delivered successfully | no | **yes** |
| `FAILED` | Delivery attempt failed | no | yes (re-attempt = new leg) |
| `CANCELLED` | Cancelled | no | **yes** |
| `REFUND_PENDING` | Refund in progress | no | no |
| `REFUNDED` | Refund completed | no | **yes** |

> Migration note: this maps cleanly onto the current values; the normalization PR
> will need a one-time data migration (`review`→`QUOTED`, `payment_sent`→
> `PAYMENT_PENDING`, etc.) and a shared status map. Not now.

---

## Future ops queue buckets (PROPOSAL — do not implement in this PR)

Today the ops dashboard shows a **flat list** of the 100 newest orders. The target
is bucketed queues:

| Queue | Membership (future statuses) |
|---|---|
| **New / Inbox** | `REQUESTED`, `QUOTED` (review/auto) |
| **Awaiting payment** | `PAYMENT_PENDING` |
| **Ready for pickup** | `PAID`, `ASSIGNED` |
| **In progress / on board** | `EN_ROUTE_TO_PICKUP`, `ARRIVED_AT_PICKUP`, `PICKED_UP`, `EN_ROUTE_TO_DROPOFF`, `ARRIVED_AT_DROPOFF` |
| **Done** | `DELIVERED`, `REFUNDED` |
| **Problem / exception** | `FAILED`, `CANCELLED`, `REFUND_PENDING` |

> The queue view + inline price input (replacing the current `prompt()`) is its
> own scoped PR. Do not start it from this doc.

## References

- `../worker/src/pages.js` — `HE` map (ops labels), `FLOW` (tracking order), `STEPS` (ops stepper).
- `../worker/src/index.js` — statuses written by create/webhook/approve/status handlers.
- `../worker/schema.sql` — `orders.status` (free text), `status_history` (append-only audit).
