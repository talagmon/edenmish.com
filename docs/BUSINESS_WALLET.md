# Business Accounts and Prepaid Wallet

## Status

Implemented and deployed through the guarded staging and production workflow.

## Product flow

1. A business user enters an email at `GET /business`.
2. The Worker sends one email containing a one-tap, single-use magic link and a
   six-digit fallback code. Both expire after 10 minutes.
3. Verification creates or finds a business user/account and sets a revocable,
   three-day `Secure`, `HttpOnly`, `SameSite=Lax` session cookie. The Worker also
   enforces the three-day maximum from the session creation timestamp, including
   sessions issued before the current policy.
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
| `GET /api/business/batch-mappings` | List safe metadata for the authenticated account's approved spreadsheet layouts |
| `DELETE /api/business/batch-mappings/:id` | Delete one account-owned reusable layout without affecting files, orders or wallet data |
| `POST /api/business/batches/parse` | Authenticated XLSX/CSV parsing, structured pickup/delivery address validation and signed row preparation; files are processed in memory and are not retained |
| `POST /api/business/batches/approve` | Exchanges the reviewed row and pickup tokens for 30-minute server-signed approval tokens |
| `DELETE /api/business/orders/:id` | Cancel an account-owned wallet order and release its reserved credit before dispatch |
| `POST /api/business/topups` | Create Shopify Draft Order top-up checkout |
| `POST /api/orders` | Existing endpoint; `use_wallet=true` reserves credit |

## Batch delivery import

The business dashboard provides a downloadable Hebrew XLSX template and also
accepts CSV. The exact template follows a deterministic parser and is never sent
to a language model. When the deterministic parser cannot recognize the headers,
the authenticated endpoint uses the configured Cloudflare Workers AI binding to
identify the header row, map unfamiliar columns, and split combined values such
as a full address or date/time. The AI step only proposes canonical row data. It
cannot quote, reserve credit, create, update, cancel, or dispatch an order.

Smart import is deliberately fail-closed. Input is bounded to 100 data rows,
24 populated columns and short per-cell prompt values; spreadsheet cells are
treated as untrusted data rather than instructions. Every proposed value must
cite cells from its own source row. Missing model rows, malformed structured
output, unavailable inference, or required-field confidence below the threshold
remain blocking errors. The proposed result then passes through the same
deterministic field, schedule, address, service-area, quote, credit, approval-token
and idempotency checks as the official template. The dashboard shows the detected
column mapping and every AI interpretation or correction for explicit customer
approval before order creation.

When the customer approves a newly detected column mapping, the Worker stores
only an account-scoped SHA-256 signature of that header layout and its canonical
field-to-column indexes. Raw headers, recipient data and uploaded rows are not
stored in the mapping cache. Each account retains at most its 20 most recently
approved or used layouts. A later file with the same header signature reuses
the approved mapping and skips the model's header-detection call. Dedicated
one-field columns are then normalized deterministically without inference;
combined values may still require bounded row normalization and every changed
value remains visible for approval.

The import drawer includes an account-scoped saved-layout manager. It shows when
each layout was last approved and used, how many times it was reused and how many
canonical fields it maps. The API does not return the header signature, raw
headers or mapping JSON. Deletion requires an explicit browser confirmation and
removes only the reusable layout; uploaded files, orders and wallet data are
unaffected. A deleted layout can be learned again only after the customer reviews
and approves it on a later import.

Recipient-specific canonical fields are:

- a customer-controlled external delivery ID, recipient name, Israeli phone,
  delivery street, house number, delivery city,
  pickup date, pickup hour and package size (`small`/`medium`, shown as
  `קטן`/`בינוני` in the template) (required);
- building entrance, floor and apartment number (optional structured address
  fields);
- customer/supplier reference, contents and courier notes (optional).

The external delivery ID must be unique within the business account and stable
across retries, for example `ORD-2026-1042`. Re-uploading or reordering rows does
not create duplicates. Reusing an existing ID with changed delivery details
updates the existing order and adjusts its reserved credit only while it remains
in `paid`/`wallet_reserved`. Once dispatch starts, the row is rejected as locked.

The XLSX date cells are real date cells displayed as `YYYY-MM-DD`; both Excel
1900 and 1904 date systems are supported. CSV dates use `YYYY-MM-DD`. Dates must
be today through 90 days ahead. Pickup times are whole-hour slots, including
native Excel time cells, and accept
`08:00` through `19:00` where the selected service and day allow them:

- Sunday–Thursday: Standard/Flash `09:00`–`19:00`; Eco
  `09:00`–`12:00`;
- Friday: all services `08:00`–`12:00`;
- Saturday: closed.

`Courier notes` is optional operational text for the driver, such as floor,
entrance instructions or a request to call on arrival. It must not contain
payment details or identity numbers. The workbook's automatic row-status column
is a formula-only local completeness check and is ignored by the importer; final
area, plan, price and schedule validation happens after upload.

The shared pickup street, house number, city, entrance, floor and apartment are
entered once as separate fields in the dashboard and pass through the same
conservative Places validation as delivery addresses. The service is also
selected once.
Package size is selected per row from the workbook dropdown. The browser validates
each row's date/time against the shared service, uploads the file to the
authenticated parser endpoint, requests an authoritative business quote for every
valid row, and shows the aggregate wallet impact before any order is created.
Accepted rows and rejected rows are shown separately. The accepted summary
distinguishes new deliveries, updates and unchanged retries, and calculates the
net credit impact plus the expected remaining balance. A shortfall links to the
existing business top-up flow. Customers can also exclude an accepted row before
confirmation.

The customer never has to assemble a free-form delivery address. The parser
validates the street, house number, city, entrance, floor and apartment as
separate fields, then composes the operational address used by quotes and order
creation. House number is mandatory and must use a supported value such as `10`,
`10א` or `10/2`; floor accepts an integer from `-5` to `100` or `קרקע`, `לובי`
or `מרתף`. Entrance and apartment accept a short letter/number identifier.
Obvious formatting such as `10 א`, `כניסה ב`, `קומה 2` or `דירה 12` can be
normalized, but the change is shown in the approval list before creation.

For the pickup and each delivery row, the authenticated parser submits only the
street, house number and declared city to Places API (New) using a server-only key. A candidate
is accepted only when it contains the exact same house number, resolves to a
supported service-area city, and the street/city similarity is high enough to
exclude competing candidates. A confident street or city typo is added to the
same explicit approval list. Entrance, floor and apartment are never inferred;
only their obvious labels/spacing can be normalized with approval. Missing or
malformed house numbers, weak matches, city conflicts and ambiguous candidates
remain blocking row errors. Provider failures also fail closed instead of
bypassing address validation.

Canonical Excel dates are decoded without user intervention. When a non-canonical
but high-confidence value can be normalized safely, such as `3/8/2026` to
`2026-08-03` in the Hebrew/Israeli template or `8:00` to `08:00`, the dashboard
shows every proposed change and requires explicit approval before enabling order
creation. The approval endpoint signs the exact normalized pickup and row values;
`POST /api/orders` rejects expired, modified or unsigned batch values. Impossible
dates, past dates, dates beyond 90 days, half-hour times and unsupported package
sizes remain row errors; the system does not guess. Corrections affect the
reviewed import values only—the uploaded file is not edited or retained.

After confirmation, each row is submitted through the existing `POST /api/orders`
boundary with `use_wallet=true` and a deterministic batch idempotency key. This
keeps D1 order creation, pricing, plan eligibility and wallet reservation in their
existing sources of truth. The idempotency key is derived from the external
delivery ID, so retrying the same deliveries from a modified or reordered file
returns unchanged orders or updates still-editable orders rather than
double-reserving credit. A batch is limited to 100 rows and 1 MB. Row failures do
not stop later valid rows: each failure is retained in a separate exception list
with its spreadsheet row number and reason, so the customer can correct and
retry only those IDs. The completion summary reports created, updated, unchanged
and rejected counts plus the actual net credit change.

The price reviewed for each batch row is enforced as a maximum charge. Order
creation fails with `batch_quote_changed` if authoritative pricing increased
after review. If an automatic promotion lowers the price, the lower reservation
is accepted and the completion summary reports the actual credit used. A
temporary first-delivery claim is released when a higher-price mismatch blocks
creation, allowing a corrected retry.

When rows are rejected, the dashboard can download a UTF-8, Excel-compatible CSV
containing only those rows, the canonical import columns, values the system
already normalized safely, the original spreadsheet row number and readable
error reasons. The export guards cells that could be interpreted as spreadsheet
formulas and remains directly retryable after the customer fixes the indicated
fields.

Before dispatch, a business user may cancel an imported order from the account
dashboard. Cancellation atomically marks the order cancelled, releases its held
wallet reservation and records the release in the ledger. Update and cancellation
are disabled as soon as the order moves from `paid` to `to_pickup`.

The file is never persisted by EdenMish. Recognized template files remain inside
the deterministic Worker parser. For an unfamiliar layout, only bounded
spreadsheet content needed for mapping and normalization is sent through the
account's Cloudflare Workers AI binding; the UI discloses this before upload and
identifies AI-assisted results. Recipient phones are stored on resulting orders
for delivery coordination, but batch import deliberately sets phone-link consent
to false; the tracking link continues to go to the authenticated business email.

## Financial invariants

- Monetary values are stored as integer agorot.
- `wallet_entries` is append-only and uses unique idempotency keys.
- Top-up credit is posted once even if Shopify retries the webhook.
- A wallet can never have negative available or reserved credit.
- Reservation writes use one D1 batch: reservation row, conditional balance update,
  and ledger entry succeed or roll back together.
- Capture/release is idempotent and changes only a `reserved` reservation.
- Credit lots expire at the plan-specific date recorded at purchase (14, 30, or 60
  days). Captures consume the oldest-expiring lot first.
- Before a wallet balance is displayed or a new delivery reserves credit, the Worker
  posts unused expired credit to the immutable ledger. Credit already reserved for an
  existing delivery remains protected until that reservation is captured or released.
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
- Advance credit-expiry notifications.
- Exact-shortfall top-up that resumes a saved draft booking.
- Ops UI for wallet adjustments, account suspension review, and reconciliation.
- True recurring billing or automatic top-up. MVP top-ups are customer-initiated.
