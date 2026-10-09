# Luna conversation-only staging pilot

Status: implemented and mock-tested; not activated. This document grants no
credential installation, deployment, provider spending or message-send authority.
The existing dedicated EdenMish key may be entered through an approved hidden
handoff; never retrieve an unrelated key, copy production credentials or create a
new key without authorization. The Worker secret destination is
`WHATSAPP_BOOKING_OPENAI_API_KEY` on `edenmish-ops-staging`.

## What the rehearsal proves

Use the intended release state machine, GPT-6 Luna transport, Twilio callbacks,
Maps validation and authoritative quote with one approved handset. Stop at final
confirmation before canonical order creation. Customer acknowledgements, numbered
choices, typo handling, relative times, corrections and handoff are the acceptance
focus. No order, invoice, customer email or driver dispatch may result.

Run the [conversation acceptance script](WHATSAPP_CONVERSATION_ACCEPTANCE.md).
Local mocked downstream tests remain necessary for the parts deliberately
excluded from the handset test: idempotent order creation, reused invoice links,
signed payment reconciliation, amount/currency mismatches and Ops/route state.
A separate provider test-mode rehearsal is still needed to verify actual external
checkout/webhook configuration. Mock success cannot establish that configuration.

## Durable limits and cost assumptions

`WHATSAPP_BOOKING_PILOT_PROFILE=luna-v1` is an additional explicit profile. The
legacy conversation-only profile still rejects model enablement. The Luna profile
requires staging URL, Twilio, exactly one allowlisted Israeli recipient,
`AUTO_DRIVER_DISPATCH=off`, privacy/spend approval, and a reviewed schema-ready flag.
Its code-fixed limits are:

| Operation | Maximum per pilot ID |
|---|---:|
| Accepted inbound messages | 24 |
| Outbound attempts, including multipart pieces | 24 |
| Google Places requests | 8 |
| OpenAI attempts, including readiness probes | 20 |
| OpenAI pool | US$0.50 |
| Reservation before each model attempt | US$0.30 |
| Concurrent model attempts | 1 |
| Live window | At most one hour |
| Model deadline | 10 seconds |

All limits can end the test early. Twenty attempts is a ceiling, not a promise.
Reserve before network I/O; a valid result settles once to a conservative token
cost. Unknown usage/model/tier, timeout, invalid proposal or failed readiness keeps
the full reservation and stops further model requests. There are no automatic
retries. A crash retains the pending reservation and lock. Late results cannot
revive the conversation or refund an uncertain call.

The D1 ledger pins pilot identity, sender, account, recipient, limits and the live
window. Redeployment with a different binding or extended window fails closed.
Readiness spends from this same ledger while its live start/end are null. The
first live use pins the approved start/end once. Ledger rows and existing pilot
rate counters are excluded from retention cleanup; never delete, rename or reset
an ID to regain allowance. New IDs require new authorization. Previous pilot
conversations remain paused; a new ID gets an isolated draft and consent.

Conservative planning estimate, reviewed 2026-10-09:

| Component | USD |
|---|---:|
| 48 Twilio message handling charges at $0.005 | 0.2400 |
| Meta service allowance, both directions, 48 at $0.0053 | 0.2544 |
| 24 failed outbound fees at $0.001 | 0.0240 |
| 8 Maps calls at highest used SKU, $0.032 | 0.2560 |
| OpenAI pool | 0.5000 |
| Subtotal | 1.2744 |
| 18% tax allowance | 0.229392 |
| Planned total | 1.503792 |
| Contingency within approved $2 | 0.496208 |

These are conservative planning allowances, not verified invoice charges. The
account-specific tax/mandatory-fee question remains unresolved. The quota was
reduced from 30/30/10 to 24/24/8 to leave more contingency. Application guards
cannot cap unrelated account usage or unsolicited provider-billed inbound traffic.
Keep the incoming callback disconnected until ready; monitor usage and stop early
if actual fees invalidate the estimate. If a strict account-wide cap cannot be
established, report that limitation before activation.

Sources: [Twilio pricing](https://www.twilio.com/en-us/whatsapp/pricing),
[Twilio country CSV](https://www.twilio.com/content/dam/twilio-com/pricing-data/en/WhatsAppPricing-pricing-details.csv),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing),
[Israel tax authority notice](https://www.gov.il/BlobFolder/dynamiccollectorresultitem/represent-info-051224-2/he/vat_represent-info-051224-2.pdf).

The model reservation covers full documented input context, 1,024 output tokens,
the higher long-context/cache-write tariff and 10% regional margin, rounded up
from $0.289595. Requests force Standard tier, no tools, `store:false`, and use
only the current consented message plus bounded field-name context. Request size
is capped at 16,000 UTF-8 bytes; response size at 32 KiB. A reasoning item may
accompany the single structured assistant message; it is ignored, never logged.

## Operator sequence after separate approvals

1. Review the diff and local tests. Keep booking/send/model/dispatch off. Record
   zero existing pilot orders/payment/email/driver writes as the baseline.
2. Apply migration 040 only to the explicitly approved staging database. Verify
   exact schema using `node scripts/validate-luna-pilot-schema.mjs --config
   <staging-config>`. This validator is read-only and never repairs/resets rows.
   Base booking migration 039 remains required. See `worker/MIGRATIONS.md`.
3. After explicit destination approval, install the existing dedicated key through
   hidden input. Do not paste it into chat, command arguments, config or reports.
   Deploy the reviewed staging code only when authorized; verify correct D1 binding
   and all ordinary activation flags still off.
4. Configure one approved pilot ID, account, sender and recipient. Set profile
   `luna-v1`, `WHATSAPP_BOOKING_PILOT_BUDGET_READY=on`, model `gpt-6-luna`, and the
   model privacy/spend flags only after their reviews. Leave live start/end unset.
5. Only under explicit probe approval, set `WHATSAPP_BOOKING_READINESS_APPROVED=on`
   and `WHATSAPP_BOOKING_READINESS_EXPIRES_AT` to a concrete deadline within one
   hour. Booking/send/model flags must all stay `off`. Through authenticated Ops
   and a trusted same-origin request, POST JSON `{ "case_id": "small_item" }` to
   `/api/ops/whatsapp/pilot/readiness`; repeat sequentially for `relative_time`,
   `public_route`, `off_topic`. No caller-supplied prompts are accepted. Repeating
   a completed case returns its stored report without another provider call.
6. Require all four fixed cases to pass. Review latency and safe failure categories;
   these are a readiness screen, not a substitute for Hebrew handset acceptance.
   Reports contain only case ID, outcome, HTTP status and elapsed time; ledgers
   additionally contain token counts/costs. No raw response or conversation body
   is retained. On failure stop and diagnose with mocks; a stopped ledger cannot
   be reopened. Do not mark evaluation approved merely because access succeeds.
7. Only when ready and activation is approved, disable readiness, set model eval
   approval, set explicit `WHATSAPP_BOOKING_PILOT_STARTED_AT` and
   `WHATSAPP_BOOKING_PILOT_EXPIRES_AT` no more than one hour apart, and enable
   booking/send/model with the approved callback. The operator records the window
   before first traffic. Do not start the hour during credential setup/probes.
8. Observe the acceptance script and quota use. A model fallback pauses the draft
   and allows only a bounded handoff acknowledgement. Payment/order creation stays
   blocked by conversation-only mode. Check zero side effects after final confirm.
9. At expiry, any exhausted allowance or failed safety check, turn booking/send/
   model/readiness off, pause the draft and disconnect the incoming callback.
   Verify no pending automated reply and no order/payment/email/driver writes.
   Preserve all spend records. Keep base storage-ready on for draft retention.
   Remove the temporary secret binding when authorized; this does not erase old
   deployment versions or revoke the key at its issuer.

Standard CI staging configuration remains disabled and does not apply 040 or
activate this profile automatically. Production requires its own reviewed release,
privacy, payment/provider validation and activation approval.
