# Business Accounts and Prepaid Wallet

## Status

Implemented locally on the business-wallet feature branch. No migration or deploy
has been run against production.

## Product flow

1. A business user enters an email at `GET /business`.
2. The Worker sends one email containing a one-tap, single-use magic link and a
   six-digit fallback code. Both expire after 10 minutes.
3. Verification creates or finds a business user/account and sets a revocable,
   30-day `Secure`, `HttpOnly`, `SameSite=Lax` session cookie.
4. The user chooses Silver (₪600), Gold (₪1,500), or Platinum (₪3,000).
5. `payment.js#createWalletCharge()` creates a non-shipping Shopify Draft Order.
   PayPlus remains the gateway inside Shopify checkout.
6. Only a signed `orders/paid` webhook with matching amount, currency, Draft Order,
   and wallet top-up token credits D1. The checkout return URL never grants credit.
7. The business booking flow asks the Worker for a plan-rate quote and shows the
   wallet balance. `POST /api/orders` with `use_wallet=true` atomically reserves
   credit using a client idempotency key.
8. Ops acceptance captures the reservation. Rejection/cancellation releases it.
   The immutable `wallet_entries` history is the financial audit trail.

## Ownership boundary

- **Shopify + PayPlus:** hosted top-up checkout and external payment evidence.
- **Worker + D1:** users, business accounts, sessions, plan, wallet balance, ledger,
  reservations, deliveries, and webhook reconciliation.
- **Browser:** untrusted presentation only. It never supplies an authoritative price
  or balance and never receives the session token in JavaScript.

## API

| Endpoint | Purpose |
|---|---|
| `GET /business` | Hebrew/RTL account UI |
| `GET /api/business/plans` | Public plan catalog |
| `POST /api/business/auth/request` | Send magic link + six-digit code |
| `POST /api/business/auth/verify` | Consume link/code and create session |
| `POST /api/business/logout` | Revoke session |
| `GET /api/business/me` | Account, wallet, orders, ledger and plan snapshot |
| `PUT /api/business/profile` | Company/contact details |
| `POST /api/business/quote` | Authoritative plan-rate quote |
| `POST /api/business/topups` | Create Shopify Draft Order top-up checkout |
| `POST /api/orders` | Existing endpoint; `use_wallet=true` reserves credit |

## Financial invariants

- Monetary values are stored as integer agorot.
- `wallet_entries` is append-only and uses unique idempotency keys.
- Top-up credit is posted once even if Shopify retries the webhook.
- A wallet can never have negative available or reserved credit.
- Reservation writes use one D1 batch: reservation row, conditional balance update,
  and ledger entry succeed or roll back together.
- Capture/release is idempotent and changes only a `reserved` reservation.
- Credit lots expire 60 days after purchase (the purchased month plus one rollover
  month). Captures consume the oldest-expiring lot first.
- A refunded wallet top-up freezes the account for manual reconciliation; card
  refunds and wallet reversals are intentionally separate operations.

## Plan coverage

| Plan | Wallet | Coverage | Fast service |
|---|---:|---|---|
| Silver | ₪600 | Zone 1 | Not included |
| Gold | ₪1,500 | Zones 1–2 | Public Flash rate, subject to availability |
| Platinum | ₪3,000 | Zones 1–3 | Discounted Flash in Zones 1–2 |

Zone 3 Flash remains unavailable. Platinum Zone 3 Priority is a manually confirmed
future service and is not represented as an automatic 90-minute API promise.

## Migration and release order

After merge and before the Worker deploy, the operator must run:

```bash
cd worker
wrangler d1 execute edenmish --remote --file=./migrations/018_business_wallet.sql
```

Then run the verification queries in `worker/MIGRATIONS.md`. Do not deploy the
business UI before the Worker migration and Worker release are complete.

## Deferred follow-ups

- Optional WebAuthn/passkeys for repeat users.
- Staff invitations and roles beyond the single owner.
- Automated expiry posting and advance expiry notifications.
- Exact-shortfall top-up that resumes a saved draft booking.
- Ops UI for wallet adjustments, account suspension review, and reconciliation.
- True recurring billing or automatic top-up. MVP top-ups are customer-initiated.
