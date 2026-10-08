# WhatsApp private booking — disabled first release

## Scope and current state

A dedicated **new Twilio WhatsApp sender** is the selected launch route. Eden's
public `+972 53-405-8498` number and WhatsApp app remain untouched. Do not delete,
migrate, deregister or enroll that number. Coexistence is not a dependency for
this separate-number plan. Account owners must separately approve any number
purchase, WhatsApp enrollment, permissions, secrets, sender/webhook setup or send.
No production configuration is enabled by this change.

The parent verified enrollment of the dedicated sender and its Online status.
Booking routing and activation remain separate gates. Recheck live readiness
before setup; keep account identifiers, credentials and private readiness
evidence outside this public repository.

Initial scope: private customers, standard service, small/medium packages, a
supported Israeli route and a future pickup within 30 days. Email remains required
for the existing tracking/OTP flow. Business-wallet spending, coupons entered in
chat, media/voice/location interpretation, proactive WhatsApp tracking and
marketing are outside this release. Automatic eligible promotions reuse the
existing coupon engine. No phone match authorizes a business account.

## Customer journey

1. First message receives a short privacy disclosure. `מתחילים` explicitly starts
   structured collection. Content sent before consent is not retained as a draft.
2. The assistant asks only for missing fields: size, pickup/dropoff street and
   house number plus city, pickup date/hour, name, email, access/contact details
   at both ends, and notes. The WhatsApp sender is the booking phone. Alternate
   stop contacts can be supplied in access details, as in the existing website.
3. Replies can be ordinary answers, multiple labelled lines (`איסוף: דיזנגוף 10,
   תל אביב`), or bounded Hebrew sentences supplying several fields together. For
   example, `חבילה קטנה מדיזנגוף 10, תל אביב לביאליק 2, רמת גן מחר בשעה 11`
   supplies size, both addresses and time. `שמי יעל כהן` and an email can be in the
   same message. Today/tomorrow use the Israel calendar and require an exact whole
   hour; the existing eligibility rules still apply. Vague times, alternatives,
   negation and unexplained remaining instructions prompt clarification. This
   grammar does not interpret arbitrary prose, voice/media or English sentences.
   Guided name/access/notes answers retain their text even when it contains size
   or date words. Explicit labelled fields remain available for names/addresses
   outside the grammar.
4. The existing Google Places business-address resolver supplies normalized
   addresses and coordinates. Ambiguity asks for a more exact address; unavailable
   validation never invents coordinates. Unsupported areas hand off. Both
   normalized addresses require `כתובות <revision>` confirmation.
5. The server computes a quote with current D1 pricing and automatic promotions.
   The full summary includes route, contacts/access, schedule, email, phone,
   package, notes, final ILS price and links to terms/privacy/cancellation.
   `אישור <revision>` accepts that summary and terms. `עריכה` or labelled changes
   revoke the old quote, including invalid attempted edits. `נציג` pauses the bot.
6. Quotes expire after ten minutes. Confirmation reprices; changes or expiry require
   another explicit confirmation. The canonical order handler independently checks
   the same exact payable amount before reserving a promotion or writing an order.
7. One canonical D1 order (`source_channel=whatsapp`) goes through the existing
   Shopify Draft Order / PayPlus invoice boundary. The same link is reused; an
   uncertain failure never creates a second checkout automatically. Customer chat,
   Twilio receipts, and browser redirects cannot mark an order paid.
8. The existing signed Shopify paid reconciliation validates amount, currency and
   reference, then runs the normal email/OTP, Ops and driver-route hooks. Paid is
   not picked up or delivered. A later customer message can ask for the current
   payment state; details remain in email/tracking.

This is bounded text understanding, not a general natural-language agent. The
baseline neither retains raw chat logs nor sends customer text to an LLM. An
[optional model interpretation boundary](WHATSAPP_BOOKING_MODEL.md) supports
synthetic proposals and a separately gated GPT-6 Luna adapter; all live model flags remain off/absent. See the
[test-generated mocked conversation](WHATSAPP_BOOKING_EXAMPLE.md) for the actual
customer flow, authoritative fixture price and payment-claim behavior.

## Architecture and delivery semantics

- `whatsapp-booking.js`: transport-independent state machine and field validation.
- `whatsapp-booking-model.js` / `whatsapp-booking-copy.js`: optional validated proposal
  validation and reviewed concise copy, with deterministic language controls.
- `whatsapp-booking-text.js`: bounded Hebrew sentence extraction; all extracted
  values pass the same field, address, schedule and price checks as guided answers.
- `whatsapp-booking-store.js`: D1 conversations, hashed event deduplication,
  per-conversation compare-and-set leases, reply outbox, takeover and retention.
- `whatsapp-booking-twilio.js`: exact public-URL HMAC-SHA1 verification, strict
  account/sender/recipient checks, message timestamp lookup, windowed replies and
  signed delivery callbacks. Uses the existing work's `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN` and recipient-policy conventions, without importing the
  unfinished Twilio link/marketing changes in another checkout.
- `index.js`: a private WeakMap keyed by an internal Request object permits the
  adapter to enter the **same** `/api/orders` handler with a reserved order token
  and reviewed quote. Public headers/body fields cannot grant this capability.
  `db.createOrder` accepts the reserved identity only through a separate internal
  options argument; its existing unique token constraint is the final duplicate guard.
- Optional direct-Meta parsing is separately selected with `provider=meta`, uses
  the existing signed endpoint, and pauses on `smb_message_echoes`. It is not the
  selected launch transport. History events are ignored. Any future Meta route
  requires provider-contract/echo fixture verification before activation.

Inbound acknowledgements follow durable processing. A busy conversation returns
503 for provider retry; duplicate event IDs do not advance or resend prompts.
Strictly older ordinary messages are ignored; customer stop/human requests and
manual echoes always pause, even when delivered late. Already paused conversations
do not emit repeat acknowledgements for same-second follow-ups. Distinct messages with the same provider
second are ambiguous and pause for review rather than applying unordered edits.
Twilio's webhook has no authoritative creation time, so the adapter reads that
message's Twilio resource after signature validation. Only its metadata is used;
its body is not retained. The original creation time bounds replay and the 24-hour
customer-service window. Configure provider retries and verify timeout behavior
with the controlled sender before launch.

Before checkout the draft is durably marked `creating` and `checkout_started_at`
is recorded independently of disposable draft content. A process crash, uncertain
provider acceptance, or expired two-minute lease moves to human review; it never
automatically repeats the charge. Operators can find an order through the stored
reserved token even if the reverse `order_id` update was interrupted. Do not use an
operator manual-price action to generate another invoice until Shopify reconciliation
confirms whether the original draft exists.

Replies use a durable outbox and a separate send gate. Long summaries are split
on line boundaries into numbered parts under Twilio’s 1,600-character limit; no
fields or totals are silently truncated. A send is claimed before
network activity. Ambiguous sends pause instead of retrying an unknown acceptance.
Signed delivery receipts are durably stored as SID/status rank only, including
callbacks arriving before the send response. Pending receipts are applied while
holding the conversation lease before another send or checkout, and replayed by
cron. Signed delivered/read events never regress to failed; transport failure
pauses future automation without resuming after a later success. Outbox bodies are cleared after dispatch, failure or supersession.
No messages are sent after the 24-hour window. No template is created or submitted
by this release. Any future outside-window messaging requires a separate approved
content-template and privacy flow.

## Operator workflow

The existing dashboard exposes a **WhatsApp** button only when booking is enabled.
It lists drafts, prioritizes handoffs and shows canonical order references. It uses
the existing HttpOnly Ops login and renders customer values with `textContent`.
No new bearer credential is stored in the browser.

- **Pause** before manual replies. Pauses cancel pending replies. A send/order call
  already in flight cannot be recalled; HTTP 409 tells the operator to retry the
  pause after it completes. Verify paused state before replying from any external
  Twilio inbox; arbitrary outside-inbox manual sends do not supply Meta app echoes.
- **Close** only after resolving a handoff. This erases its draft/contact fields
  and permits a fresh conversation on the next inbound message. It does not cancel
  an order. Close is allowed only if no checkout was attempted/no order exists,
  or the canonical order is paid. **D1 cancellation is insufficient:** it does not
  void a Shopify invoice. Missing D1 data after an attempt is also insufficient.
  Unpaid or uncertain attempts remain blocked (HTTP 409), including after draft
  retention. This release has no provider-void/reconciliation override. An audited,
  provider-verified recovery workflow must be reviewed before adding one; do not
  delete the safety record or mark an order paid to bypass the restriction.
- No customer phrase resumes a handoff. One unresolved automated booking per
  sender is intentional in this first release. Start another through operator
  pause/close after the previous order is paid, or close an unsubmitted draft.

Endpoints (all Ops-authenticated; mutations additionally require the trusted
Origin or existing `X-Ops` authentication):

- `GET /api/ops/whatsapp/bookings`
- `POST /api/ops/whatsapp/bookings/:id/pause`
- `POST /api/ops/whatsapp/bookings/:id/close`

This queue needs an assigned human owner and operating hours at activation. It
does not imply an operator has read it, and it sends no new unsolicited handoff email.
Normal canonical order/payment notifications continue through existing hooks.

## Data boundary

D1 stores one structured draft, recipient for response routing, opaque order token,
HMAC sender/event identifiers, provider message reference and bounded status data.
Raw inbound bodies, attachments, secrets, card data and provider error descriptions
are never intentionally persisted or logged. Probable card-number strings are
rejected before field storage. Do not enable request-body logging at the edge.

Structured draft/contact data expires after 48 hours; unsent reply bodies expire
by 24 hours. Outbox/receipt metadata lasts seven days and event tombstones eight
days. Conversation metadata (including consent/confirmation timestamps, revision
and reviewed amount) normally lasts thirty days. **Unresolved checkout attempts
retain their HMAC sender key, reserved token and safety metadata beyond thirty days**
until canonical payment is verified; draft/contact PII still expires at 48 hours.
This exception prevents retention from reopening an uncertain payable invoice and
requires explicit privacy approval. Canonical orders follow existing order retention.
Cleanup runs on the existing cron even after booking/sends are turned off, as long
as the storage-ready flag remains on. It runs at cron time, not at exact expiry.
Closing a conversation immediately removes draft/contact data.

The existing WhatsApp operations runbook only authorizes narrowly constrained
proactive templates. **It does not approve the broader customer-initiated booking
PII/summary/payment-link boundary here.** Complete an explicit privacy review,
retention/disclosure review and issue #216 evidence before activation.

## Configuration and exact activation sequence (operator reference; not executed)

1. Review the release workflow checks before merging to `develop`, which triggers
   staging deployment. The workflow applies 039 only when wholly absent, verifies
   its full schema, and enforces dispatch/booking/send/model flags off. A partial
   migration stops deployment for inspection. Independently review enrollment.
   Choose a dedicated sender in the EdenMish account, preserving the public number.
   Confirm the sender is WhatsApp-enabled: purchasing an SMS number alone is not enough.
2. Confirm migrations through 038 (including any separately merged 035/036 work).
   Apply 039 before deploying this Worker: it adds the source field used by all
   order inserts, even while booking is disabled. Exact production command:
   `cd worker && wrangler d1 execute edenmish --remote --file=./migrations/039_whatsapp_booking.sql`
   Do not run twice: the additive `ALTER TABLE` is intentionally one-time.
3. Verify schema with the queries in `worker/MIGRATIONS.md`. Deploy only after
   separate deployment approval. Set `WHATSAPP_BOOKING_STORAGE_READY=on` after the
   tables exist and keep it on for retention even during channel shutdown.
4. Complete privacy/terms/retention evidence; assign a monitored Ops handoff owner.
   Confirm existing payment reconciliation, email delivery, Google Places and
   driver activation are ready in the target environment. Accept the conservative
   unpaid-checkout restart restriction and define an escalated recovery owner; any
   future provider-verified void override requires separate implementation/review.
5. Configure secrets through the approved secret manager (never command arguments,
   git or chat): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SESSION_SECRET`, existing
   `GOOGLE_PLACES_SERVER_KEY`, Shopify and email secrets. Never reuse live payment
   or messaging credentials in local tests.
6. Set non-secret flags/values in the target environment, initially sends off:

| Variable | Required value/purpose |
|---|---|
| `WHATSAPP_BOOKING_STORAGE_READY` | `on` only after migration; keeps retention running |
| `WHATSAPP_BOOKING_ENABLED` | `on` only after approval; absent/off disables intake |
| `WHATSAPP_BOOKING_PRIVACY_APPROVED` | `on` only after new scope evidence is approved |
| `WHATSAPP_BOOKING_PROVIDER` | `twilio` for the selected separate-number route |
| `WHATSAPP_BOOKING_SEND_ENABLED` | `off` until controlled sending approval, then `on` |
| `TWILIO_BOOKING_FROM` | `whatsapp:+<dedicated approved sender>`; public number rejected |
| `TWILIO_BOOKING_WEBHOOK_URL` | Exact public HTTPS URL ending `/webhooks/twilio/booking`; no query/fragment |
| `TWILIO_RECIPIENT_POLICY` | `allowlist` for controlled tests; `open` requires launch approval |
| `TWILIO_RECIPIENT_ALLOWLIST` | Exact comma-separated E.164 controlled recipients |

7. With approval, configure Twilio inbound POST to the exact URL above. Replies
   register the signed status callback at that URL plus `/status`. The endpoint
   returns empty TwiML; the durable outbox owns sends, so retries do not duplicate
   TwiML responses. Do not change existing link/marketing callback routes.
8. Run a controlled sandbox booking at an operator-owned recipient. Verify address
   corrections, price changes, duplicate/delayed callbacks, handoff, one invoice,
   paid mismatch rejection, email OTP, Ops appearance and correct driver routing.
   Validate provider retention/redaction controls and same-second timestamp behavior.
9. Only after explicit launch approval enable sending/open-recipient policy and
   publish the dedicated booking number/CTA. This branch does not alter website
   links or publish a number. Retain the existing personal-contact CTA until the
   owner approves the customer-facing routing choice.

Disable intake/sends with `WHATSAPP_BOOKING_ENABLED=off` and
`WHATSAPP_BOOKING_SEND_ENABLED=off`; retain the storage-ready flag for cleanup.
Existing canonical orders still reconcile through the normal payment pipeline.

## Local verification

`cd worker && npm test` uses Node 22, SQLite-backed D1 fixtures and mocked providers.
`whatsapp-booking.test.js` covers collection, consent, address review/ambiguity,
invalid edits, unsupported areas, price/expiry, duplicates/out-of-order/busy/crash
paths, original Twilio timestamp/signature/allowlist checks, single canonical order
and invoice, failed checkout, amount/currency reconciliation, operator auth/CSRF,
retention and delivery failures, including early callbacks with concurrent
dispatchers, failed delivery during quote confirmation, delayed human requests,
and cancelled/unpersisted checkout restart prevention. Natural extraction tests
cover multi-field sentences, Israel date boundaries and ambiguous instructions.
No tests send real messages or payments.

Independent review identified and reproduced the callback, takeover and restart
defects; regression tests now cover each, including the concurrent-dispatch race.
Real Twilio callback URL normalization/retries, D1 multi-isolate behavior, actual
email delivery and live provider timeout recovery still need controlled staging
verification. Local mock success does not clear these activation gates.

Provider references: [Twilio request security](https://www.twilio.com/docs/usage/security),
[Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource).
