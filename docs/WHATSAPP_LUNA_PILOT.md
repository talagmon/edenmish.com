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
| Reservation before each live model attempt | US$0.30 |
| Reservation for the selected synthetic readiness case | US$0.10, never refunded |
| Concurrent model attempts | 1 |
| Live window | At most one hour |
| Model deadline | 10 seconds |

All limits can end the test early. Twenty attempts is a ceiling, not a promise.
Reserve before network I/O; a valid live result settles once to a conservative
token cost. A readiness attempt retains its full $0.10 allocation, including its
counting/fee margin, even when successful. Unknown usage/model/tier, timeout, invalid proposal or failed readiness keeps
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

The live-pilot model reservation covers full documented input context, 1,024 output tokens,
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
5. Only under explicit probe approval, select `WHATSAPP_BOOKING_READINESS_CASE=small_item`,
   set `WHATSAPP_BOOKING_READINESS_APPROVED=on`, and give
   `WHATSAPP_BOOKING_READINESS_EXPIRES_AT` a concrete deadline within one hour.
   Booking/send/model flags must all stay `off`. Open `/pilot-ops` on the staging
   Ops host, log in through its masked PIN field if needed, and click
   **הפעלת בדיקת Luna אחת** (Run one Luna readiness check) exactly once. The button
   appears only for the enabled, unexpired `small_item` check and is usable only
   after Ops authentication. It makes a trusted same-origin POST `{ "case_id": "small_item" }` to
   `/api/ops/whatsapp/pilot/readiness`. Other cases are rejected unless explicitly
   selected by the operator. The first check is one synthetic generation, not an
   automatic four-case run. Replays return the stored report without another call. The UI writes only a
   non-secret attempt marker to localStorage before sending and stays locked after
   success, failure, timeout, reload or interruption. It never calls on page load.
   Blocked browser storage prevents submission. Do not clear the marker to retry;
   check D1 with the operator if the outcome is uncertain. Reports render as text.
6. For that single case, the same bounded input (instructions, input, reasoning,
   schema) first goes to `/v1/responses/input_tokens`. Refuse more than 4,096 input
   tokens, a body over 8,192 UTF-8 bytes, invalid counting output, expiry or timeout.
   Only then generate, with `max_output_tokens:512`, Standard tier and no tools or
   history. Verify actual input usage equals the count and output is at most 512.
   An uncertain count or generation keeps the $0.10 reservation and stops; no retry.
   Check the interpretation and latency before considering further cases or handset
   testing. A single pass establishes first interpretation, not complete quality.
   Fixed cases `relative_time`, `public_route` and `off_topic` remain available for
   separately reviewed selection. Reports contain safe outcomes/numeric metadata and, on the first response only,
   the bounded model answer to this fixed fictional probe. It is returned only to
   authenticated Ops, never from customer messages. No credentials, headers or
   provider error messages are returned. The D1 replay retains only safe metadata. Do not mark evaluation approved from access alone.
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

## Incremental first-probe cost review

This is preparation only; no live probe is implied by the code. The selected
`small_item` request measured 3,996 UTF-8 bytes offline; the real token count must
still be obtained before generation. Counting uses the identical supported input
fields, including schema. [OpenAI's counting guide](https://developers.openai.com/api/docs/guides/token-counting)
explains that the count includes formatting/schema overhead; byte length is not a
token estimate. The [count endpoint reference](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
defines its input and response contract.

At 4,096 input and 512 output tokens, applying the higher published Luna rates
($0.25 input/cache-write and $0.75 output per million) plus 10% regional margin
gives **$0.0015488 maximum generation allowance**. The normal short-input tariff
is lower; this calculation deliberately uses the higher rates. The code reserves
and retains **$0.10 for the single count+generation attempt**, from the same pilot
pool, before either request. Twilio and Maps incremental cost is zero in this
probe because neither is called. No payment, email or driver paths run.

The primary counting documentation inspected does not explicitly state a separate
counting-endpoint fee. Account-specific taxes and mandatory fees are also not
verified. The retained margin is an allowance, not a certified invoice ceiling.
The operator approved a retained $0.10 allowance for this single probe within
the existing $2 total. These generic fee uncertainties do not block that bounded
probe: [published pricing](https://developers.openai.com/api/docs/pricing) states
that Responses API is not priced separately, and tokens are billed at model rates.
No separately priced optional service or minimum request charge is documented
for this tool-free text request. Exact input counting is retained because the
[official guide](https://developers.openai.com/api/docs/guides/token-counting)
explains that local tokenizers cannot reliably include schema/format overhead.
No specific known fee exceeds this allowance. The prior $0.30 context-sized reservation is **not**
used for readiness; the actual input/output caps above are enforced. Old evaluation
ledgers and pilot counters remain unchanged. No new spend approval is requested.

## Separately approved second readiness attempt

A single follow-up after the first transport failure requires both
`WHATSAPP_BOOKING_READINESS_ATTEMPT=2` and
`WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED=on`. Its fixed case remains
`small_item`, with request ID suffixed `:2`. The same budget must contain exactly
one uncertain transport-failure attempt retaining $0.10, no live window and no
active lease. Reservation atomically adds $0.10, preserving the first attempt and
the stopped reason. Total held becomes $0.20; there is no refund, ledger reset,
automatic retry or third attempt. Even success leaves customer automation stopped.
The UI uses the second ID for its lock and request; stale first-attempt requests
are rejected. The existing deadline is not extended by this authorization.
