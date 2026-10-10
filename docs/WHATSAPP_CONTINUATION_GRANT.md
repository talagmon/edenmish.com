# Quote-v2 handset continuation grant, version 1

Offline implementation only: no remote grant, migration, deployment, credential
entry or activation. Default configurations remain unchanged. This continues the
separately authorized October 9 run, not the October 8 pilot/evaluation budgets.

## Immutable history and authority

The original `luna-v1` identity, binding hash, three readiness records, $0.30
retained and `stopped_reason=transport_failure` stay unchanged. Migration 041 adds
separate grant/operation tables, excluded from cleanup. Exactly one grant per
original run is allowed: `<pilot-id>:quote-v2-handset-1`, version 1. Its hash pins
original configuration, new limits/costs and fixed start/end. Re-issuance, new IDs,
extension, changed sender/recipient or changed history fail closed.

Issuance requires exactly the original transport failure, readiness mismatch and
valid proposal, each retaining $0.10, no legacy lease/window and no handset usage
for that October 9 ID. Other dates/IDs remain separate. Each operation verifies a
fingerprint of the historical ledger; no stop/hash/counter is cleared or rewritten.

Only authenticated same-origin Ops can POST
`/api/ops/whatsapp/pilot/continuation/grant` with exactly
`{"grant_id":"<approved-id>","version":1}`. The operator page offers one explicit
preparation button only with customer flags OFF and issuance approval present.
It locks before submission; uncertainty requires inspection, not retry. Customer
traffic never creates grants. Issuance does not activate any flag. Operator Pause
stops the grant and current draft; in-flight requests cannot be recalled.

## Limits and cost accounting

| Operation | Maximum / retained allowance |
|---|---|
| Fixed window | 30 minutes, no extension |
| Accepted inbound | 10 × $0.0103 |
| Outbound pieces/attempts | 10 × $0.0113 |
| Actual Maps requests | 3 × $0.032 |
| Interpretations | 6 × $0.03, including failures |
| Each interpretation | One token count + at most one generation; no retry |
| Payload | ≤8 KiB; ≤4,096 counted input / 512 output tokens |
| Model | GPT-6 Luna, Standard, no tools, `store:false` |
| Concurrent provider operation | One; crash retains lease and reservation |
| Historical model holds | $0.30, unchanged |
| Cumulative model sub-cap | $0.50; history + six new attempts = $0.48 |
| Fixed fee cushion | $0.50 reserved once at issuance |
| Same-run accounting cap | $2, including history, cushion and operations |

Messaging assumptions include $0.005 handling + $0.0053 service allowance in both
directions, plus $0.001 outbound failure allowance. These are conservative inputs,
not claims that every message incurs every fee. New messaging/Maps total $0.312;
model reservations $0.18. With historical $0.30 and fixed $0.50 cushion, the maximum
planned accounting is **$1.292**, leaving $0.708 unallocated. No 18% tax assertion
is needed. Success never refunds a reservation. Duplicate operations cannot spend
or authorize repeat provider IO; ambiguous results stop the grant.

The $2 limit is a hard internal accounting/request cap, not a provider-account
invoice guarantee. Unrelated usage, unsolicited billed inbound or unbounded
mandatory fees cannot be capped here. A bounded fee assessment must support the
assumptions/cushion. Missing review, invalid/unknown cost assumptions, fees beyond
the cushion or unverified token usage fail closed. Do not label actual unknown
tax as 18%. If assumptions cease to hold, stop and preserve all holds.

## Sequence after one new bundled approval

1. Review code/tests, the exact tester/sender, provider data flows, window and
   allowance. Complete offline/schema/provider-metadata preparation before asking
   for the key; no repeated key requests for separate synthetic probes.
2. Apply only missing 041 to approved staging D1 after 039/040 prerequisites. Run
   `node scripts/validate-continuation-schema.mjs --config <staging-config>`.
   Never reset/repair historical rows to pass validation.
3. Deploy reviewed source to staging with booking/send/model/dispatch OFF. Set
   explicit variables (absent by default): `WHATSAPP_BOOKING_CONTINUATION_SCHEMA_READY=on`
   after schema check; `..._VERSION=1`, exact `..._ID`, `..._APPROVED=on`,
   `..._COST_REVIEW=bounded-v1`, `..._COSTS_UNKNOWN=off` after bounded fee review;
   immutable ISO `..._START` and `..._END` ≤30 minutes apart. Issuance is allowed
   only within 30 minutes before start. All three readiness approvals remain OFF;
   old pilot start/end stay unset. Announce exact Israel times when ready.
4. User personally submits the existing EdenMish key once through hidden input to
   `edenmish-ops-staging / WHATSAPP_BOOKING_OPENAI_API_KEY`. Existing project
   permissions/billing authority unchanged. No vault/clipboard read, new key,
   production-secret copy, permission or billing change. Verify metadata only.
5. While customer flags are OFF, click authenticated Ops preparation once and
   verify the row/history. Then separately perform the already approved activation
   of booking/send/model/evaluation, with dispatch OFF and exactly one tester.
   Same dedicated staging callback only; no public-number migration or templates.
6. Use fictitious contact details/public addresses. The conversation-only boundary
   stops final confirmation before order/invoice/email/driver creation. Corrections
   revoke quote/consent; human takeover pauses the draft. Stop on uncertainty.
7. At completion, failure, exhaustion, operator stop or expiry, turn booking/send/
   model/continuation approval OFF, clear incoming callback as approved and remove
   the active temporary key binding. Verify all records and unchanged production.
   Expiry rejects further IO even if cleanup is delayed. Active-binding deletion
   does not erase historical Worker versions or revoke the issuer's key.

## Evidence and limitations

Node and actual workerd/D1 tests cover issuance gates, historical preservation,
fixed hash/window, replay/idempotency, crashes, concurrency, unknown costs, token
count/usage mismatch, expiry between count and generation, late responses,
operator stop, quotas and SQL accounting constraints. All external traffic is
mocked. A signed WhatsApp fixture follows Hebrew multi-field extraction, Maps and
canonical quote mocks, an address edit and renewed short/numbered confirmations,
with zero order/payment/email/driver writes.

The handset script will cover keys/envelopes, typo/city-first addresses,
today/tomorrow/dayparts, correction, acknowledgements, business-only responses
and handoff. Three Maps requests may cover only one route plus an edit; ten
messages/six interpretations may stop the test before every story completes.
Report incomplete coverage instead of extending. Actual Hebrew conversation
quality, provider fees, external checkout/reconciled webhook and production
release remain separate evidence/approval gates.
