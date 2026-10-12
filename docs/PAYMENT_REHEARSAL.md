# Protected payment rehearsal (local implementation)

This is a real ₪1 checkout test, not a delivery purchase. Local code is prepared;
no deployment, new provider calls, grant issuance, sends or payment were performed.
Runtime is selected only by PAYMENT_REHEARSAL_CONFIG, enabled separately by
PAYMENT_REHEARSAL_ENABLED=on. Never install this selection in production.

The exact private host is https://edenmish-ops-staging.edenmish.workers.dev.
`/ops` serves the existing Ops application from this host; `/t/:token` and OTP
API requests stay in the same private database. Native driver preview is outside
this release: held orders are excluded from driver routes and assignments.

## Capability and canonical path

Configuration fields: version=1, run_id, starts_at, expires_at (maximum30minutes),
shop (verified EdenMish myshopify domain), variant_id (dedicated product15422576689469),
phone (one approved own-number E.164), email (test buyer), ops_email (owner).
AUTO_DRIVER_DISPATCH=off, SHOPIFY_WEBHOOK_REGISTRATION=off and BOOKING_URL must match.
POST `/api/ops/payment-rehearsal/grant` requires the existing authenticated Ops
session and trusted mutation origin, exact `{version:1,run_id,approve:true}` and
all booking/model/send/rehearsal flags OFF. Then a separate full-booking grant is
required; its allowlist must contain exactly this phone and its approved provider
budget remains independent. Never derive authorization from a phone match alone.
POST `/api/ops/payment-rehearsal/stop` stops the immutable run. Expiry also gates
all new effects. The full-grant stop and external callback/queue shutdown remain
part of coordinated cleanup, not implicit work done by this module.

Normal address, schedule and service eligibility are still canonical. Only this
capability changes the payable test amount to1ILS; final chat summary explicitly
states real payment, no pickup/delivery. No coupons, wallet credit or business
identity are accepted. Confirmation rechecks the quote and claims exactly one
order token. The canonical order INSERT atomically applies an immutable dispatch
hold through migration053. Failure burns the claim instead of creating another
order. Existing canonical channel recovery reuses the saved order/link.

createCharge remains the sole payment boundary. Its rehearsal adapter reserves
one charge attempt before network access. It performs at most three Shopify calls:
correct shop/product/variant/publication audit; draftOrderCalculate; draftOrderCreate.
Each has5s transport budget,15s aggregate, clipped to run expiry and the channel's
operator/deadline checks. Responses are limited to64KiB. There are no retries.
The draft uses one dedicated nonphysical/untracked/non-taxable/unpublished DRAFT
variant, no automatic/coupon discounts,1ILS override and the approved buyer email.
Both shop/presentment totals must be1ILS, shipping/tax/discount0 and taxesIncluded=true
in calculation and returned draft. Unexpected result never exposes a payment URL;
a returned draft ID is retained for financial reconciliation even if totals fail.
Tal checks the actual checkout total and personally pays. No card input in WhatsApp.

## Payment callback and audit

A separately reviewed Shopify subscription must deliver to
`/webhooks/shopify/rehearsal`. No production callback is replaced or relayed by this
code. Normal HMAC verification runs first; the exact Eden shop header and existing
held order are required. Unknown orders are acknowledged without creating records.
The canonical paid transition matches amount/currency and signed line properties:
_tracking_token, _edenmish_rehearsal_id, quantity1 and the dedicated variant ID.
A draft ID supplied by a provider must also match. We do not require the undocumented
`draft_order_id` field: the published orders payload does not promise it.
After stop/expiry a matching signed financial event may still update the audit;
it cannot restart conversation, send email or dispatch. Duplicate and later pending
payment events cannot downgrade or duplicate the paid ledger. Refund events use
normal reconciliation; this does not authorize issuing a refund.

Shopify reference: https://shopify.dev/docs/api/webhooks/2026-04?reference=toml
Draft calculation: https://shopify.dev/docs/api/admin-graphql/2026-04/mutations/draftOrderCalculate
Remote schema validation for new operations is BLOCKED pending approval-review
clearance; see the coordinator activation bundle. Prior prototype validation is not
proof that this new runtime operation has passed remote validation.

## Notifications, privacy and cleanup

At most4 SendGrid attempts during the active run to the exact configured buyer/owner:
new-order Ops, paid buyer OTP, paid Ops and optional OTP resend. All are labelled
payment-test/no-delivery. Attempts are reserved before send; no automatic retry.
Generic WhatsApp template sends are blocked. Canonical paid transition retains its
durable notification audit job, but no generic outbox scheduler runs in this profile.
Shopify/PayPlus notifications/accounting operate outside these code caps; approve
and verify their recipients/fees separately. This runtime cannot suppress those.

Grant storage retains keyed digests of contacts, not another plaintext contact list.
Canonical order/financial records retain required booking identity and audit.
Existing durable-chat cleanup: reply bodies24h, conversation details/recipient48h,
receipts/replies7days, event records8days, eligible conversations30days. Uncertain
checkout tombstones and spend holds are retained. Cron runs DB-only maintenance.
Provider-side retention is separate; no transcript sharing is granted.

Ops shows the test badge and permanent dispatch hold. Archive via authenticated
`/api/ops/orders/:id/rehearsal/close`; payment/status/audit remain, physical timestamps
remain empty. This does not cancel a Shopify draft, invalidate a payment link,
refund a payment or release a driver. An already issued invoice can remain payable
after the30minute conversation ends. Retain a scoped financial callback until the
existing draft/payment is resolved; then remove the rehearsal subscription only.
