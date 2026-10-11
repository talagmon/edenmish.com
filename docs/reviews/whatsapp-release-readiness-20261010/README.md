# WhatsApp release readiness — 10 October 2026

**RC3 is prepared for OFF-only staging; live handset and production readiness remain pending.**
See [the staged delivery plan](RC_STAGING_PLAN.md), [fresh final checks](rc3-validation.json)
and [independent RC3 review](independent-rc3-review.md). OFF deployment is separate
from the paid v6 workflow and requires no model key or paid-test fee evidence.
The following detailed review and historical provider observations remain applicable.
This review covers published delta `5ed1e2e..c6e4e5c5023833fab7df7ae6996a4b01e56657cc`
and the local follow-up fixes below. It is not a deployment or authorization to
spend, send, merge, or reactivate a closed grant. Private customer transcripts
were not accessed. Synthetic fixtures and sanitized numeric metadata were used.

## Review and local changes

An independent reviewer inspected the delta and re-reviewed the fixes. All 11
new targeted Worker regressions passed independently; no blocking defect was
found in the scoped follow-up. Confirmed defects fixed:

1. Voice ordinals/localized confirmation aliases previously bypassed the typed
   confirmation guard. Every normalized alias now passes that guard.
2. An unresolved address without candidates discarded later valid fields in the
   same turn. Those fields now survive; the failed address remains unset and no
   quote can use it. This is address-error retention, not a claim that every
   invalid field permits later fields to be processed.
3. Address-candidate selection rejected natural corrections before interpretation.
   A grounded replacement for the pending field now returns through canonical
   resolution. Pending independent fields survive; uncertain replacement retains
   the current choices. Numbers remain shortcuts, not a required text format.
4. OFF/expired automation hid existing handoffs and prevented operator recovery.
   Authenticated storage-ready Ops can now inspect/pause/close existing drafts.
   Auth/origin checks and unpaid/uncertain-checkout close safeguards remain.
5. A Twilio location label could be mistaken for a text menu confirmation.
   Location coordinates and labels now stay outside draft/model input. The bot
   asks for a typed street, house number and city. Location resolution is not
   implemented. Attachment fallback advertises audio only when voice is enabled.

Runtime changes are in `whatsapp-booking.js`, `whatsapp-booking-store.js`,
`whatsapp-booking-twilio.js`, `whatsapp-booking-i18n.js`, `index.js`, and the Ops
`dash.html`. Canonical price, order, payment and driver logic was not changed.
No schema migration is required for these initial fixes. The new bounded v6
runner/grant below separately adds migration047; it has not been applied remotely.

## Verification

[Commands and exit codes](commands.json) and adjacent logs are from a clean
snapshot plus these fixes, with provider calls mocked and `API_URL` empty.

| Check | Result |
| --- | --- |
| Worker suite | 1,254 passed, 65 suites, zero skipped/failing |
| Focused quote/size/live-regression suite | 299 passed (overlaps Worker suite) |
| Storefront suite | 175 passed, zero skipped/failing |
| Shutdown supervisor | 8 passed |
| Worker source/scripts syntax | 73 files passed |
| Storefront inline-script syntax | 13 scripts passed |
| Independent scoped re-review | 11 targeted Worker regressions passed |

The final additional checks exercise OFF-state refusal to close an unpaid
external checkout and actual Ops dialog behavior while automation is disabled.
The dialog displays customer values as text, retains recovery controls, and
shows a failed-close warning without claiming an invoice was cancelled.

## Risk-based flow matrix

All automated results below are **offline/mocked**, unless explicitly described
as historical provider observations. Paths are relative to `worker/`.

| Flow / risk | Verified behavior and evidence | Remaining release gate |
| --- | --- | --- |
| Consent / first contact | `whatsapp-booking.test.js`, `whatsapp-multilingual.test.js`: explicit policy consent; older text consent cannot imply audio consent | Handset wording/usability acceptance; pre-consent booking details are not retained |
| Natural Hebrew, menu equivalents | `whatsapp-booking-usability.test.js`, `whatsapp-booking-model.test.js`: literal aliases scoped to current menu; supplied grounded fields retained; ask missing details | Broader real-provider multi-turn evidence; ambiguous candidate corrections still show choices |
| Hebrew/English/Arabic/Russian/French | `whatsapp-multilingual.test.js`: sticky explicit language, digit normalization, fixed catalogs, negation and role checks | Native-speaker review and provider quality in each claimed launch language |
| Typo/ambiguous addresses | `whatsapp-route-prefix.test.js`, `whatsapp-booking-model.test.js`: exact evidence, canonical resolution, candidate selection, no invented address | Owner handset correction scenario with actual Maps results |
| Pickup/dropoff swaps and corrections | `whatsapp-route-prefix.test.js`, `whatsapp-booking-quotes.test.js`: scoped negation, alternatives, Hebrew prefixes, swapped-role rejection | New synthetic provider checks on current context |
| Failed address / partial conversation | New model tests preserve destination/date/email after failed pickup; rejected address stays absent | Other invalid-field early returns remain bounded clarification, not universal extraction |
| Keys/envelopes/package size | `whatsapp-size-context*.test.js`, `whatsapp-live-regressions.test.js`: contextual item grounding, pronoun-only/invented size rejected | Latest size-context revision has no fresh provider or handset validation |
| Today/tomorrow/daypart/word-hour | `whatsapp-booking-usability.test.js`, quote/model fixtures: Israel calendar, explicit day if missing, date plus daypart offers numbered valid slots | Slots reflect service rules/lead time, **not reserved driver capacity** |
| Unsupported region/slot/service | Booking tests: invalid times rejected, out-of-zone/manual services hand off, no wallet inferred from phone | Operational manual coverage and customer wording |
| Price / stale quote / edits | Booking tests: shared authoritative quote; expiry and edits revoke confirmation; price race blocks checkout | Real provider contract/sandbox verification; no live financial action in proposed test |
| Final confirm / modify | Usability tests: menu revision binding; aliases accepted; voice cannot create or accept final summary | Typed final confirmation remains required |
| Cancel/stop/handoff | Booking tests: handoff pauses automation; delayed human request dominates; no automatic restart | Human staffing and response ownership; “cancel” is not order/payment cancellation |
| Operator recovery / restart | New OFF/expired API tests + storefront behavioral test: authenticated read/pause/close; unpaid checkout refuses close; new draft only after eligible close | Staging UI acceptance after approved deployment |
| Durable event replay / concurrency | Booking and transport tests: duplicate/out-of-order events, leases, one checkout attempt/invoice, uncertain provider result no blind retry | Production load/alert thresholds and operational recovery rehearsal |
| Signed Twilio / Meta inbound | `whatsapp-worker-transport.test.js`, booking tests: account/recipient/signature and message resource binding | Current account/sender/callback verification by browser owner |
| Audio | `whatsapp-audio.test.js`, voice profile/worker/session tests: signed media, explicit consent, 2MiB/60s bounds, verified formats, redirect credentials stripped, transcription gate | Zero transcription calls in latest session; real audio unproven; production voice profile absent |
| Location / unsupported attachment | New signed location regression strips coordinates and label; cannot confirm; localized typed-address fallback | Location-pin resolution intentionally unsupported |
| Model refusal/schema/timeout/cost | OpenAI/pilot/continuation tests: strict evidence/schema; unknown usage fails closed; no retries; one bounded pause notice only | Failure-rate/latency acceptance with real provider; production reasoning profile absent |
| Order / secure invoice / email OTP | Signed mocked booking integration: one canonical order, one Shopify Draft Order invoice, email preserved, OTP hashed | Separate provider sandbox checkout/email contract test; no live order in this proposal |
| Paid reconciliation / downstream | Mocked signed Shopify webhook: amount/currency/reference validation, duplicates, Ops/notification jobs and route pipeline; paid does not mean picked up/delivered | Separate non-production signed-provider payment test and dispatch simulator; production activation prohibited |
| Business wallet | Booking tests: phone match cannot authorize wallet spending, unsupported business request hands off | Explicit authenticated authorization required in a later scope |
| Auth / privacy / retention | Booking/ops/audio tests: Ops auth+origin, secret/card filters, no arbitrary model prose/tools, bounded metadata and retention | Retention/operations review and explicit permission before private transcript inspection |
| Monitoring / shutdown / rollback | Supervisor + continuation tests: expiry/operator stop/unknown outcomes block work; fixed notice never extends expiry; closed grant cannot reopen | New immutable grant and two working shutdown processes; verify OFF/key absent/callback blank after test |

## Provider findings and latency

The first Sol-low synthetic call reported `route_ambiguous`. Its raw proposal was
not retained. Offline reproduction identified the reachable prefix-marker defect:
quotes containing Hebrew pickup/delivery prefixes failed while equivalent quotes
excluding those prefixes passed. The prefix fix preserves raw evidence and
independently verifies roles; it does not establish the exact lost provider quote.

Subsequent sanitized historical reports record one semantic mismatch (5/6 fields),
then a separately approved description test matching all six fields at both low
and medium effort. This is one synthetic case, **not** a quality/completion pass
for all flows. Both reports retain `qualityApproved:false` / `handsetReady:false`.
Latest closed handset session reported `proposal_schema` / `size_unsupported`;
no private transcript or unretained proposal was used to reconstruct its wording.

| Historical description test | Model round-trip | Local validation | Input / output / reasoning tokens | Usage-derived upper estimate |
| --- | --- | --- | --- | --- |
| Sol low, Standard tier | 4,146ms | 43ms | 871 / 98 / 0 | $0.003474 |
| Sol medium, Standard tier | 4,037ms | 2ms | 871 / 185 / 85 | $0.004431 |

`reasoning.effort` is serialized and tested; output limits include reasoning.
Low effort does not guarantee a positive reported reasoning-token count. These
are client-observed provider round-trips, not provider compute time or WhatsApp
end-to-end latency. One case cannot establish typical speed. The product target
of 2–3 seconds is not demonstrated; no none mode or premium tier is proposed.

## Read-only staging and budget checkpoint

On 10 October, deployed staging version
`077b9fdb-cbac-4ba4-b5bd-b2a588c439cf` (deployed 12:00:57Z) still had booking,
sending, model use and driver dispatch OFF; voice profile OFF; conversation-only
mode; allowlist policy; Sol low configured; temporary OpenAI key binding absent.
This local delta is not deployed. Current Twilio/Meta UI state was not available
in this execution environment. Browser owner must freshly verify the dedicated
sender/account and incoming callback blank. Verification ticket remains pending;
no resubmission was performed.

A fresh read-only numeric D1 lookup matched the last closure receipt:
prior operational/model holds $0.735124, version-5 operation holds $0.121120
(3 inbound, 3 outbound, 1 model, 0 address); model hold $0.056320;
stopped reason `model_uncertain`. Audio ledger: 0 calls, $0 reserved, $0.03
approved. Keep that unused audio allowance reserved rather than refunding it.

Conservative retained total is **$1.636244**: prior $0.735124 + original fee
cushion $0.50 + version-5 $0.121120 + its $0.28 audio/fee reserve. This deliberately
retains both cushions. Prior approvals total $3.65 ($2 original + $1.65 voice);
arithmetic headroom is $2.013756. It is **not permission to reopen grants or reuse
unused allocations**. These are reservations, not an account invoice statement.

## Superseding bounded-test proposal

The initial $1.10 proposal is withdrawn. [Exact approval bundle](APPROVAL_BUNDLE.md)
reconciles the later retained holds against the original $2 ceiling and proposes
**$0.35**: one synthetic provider check, then a conditional eight-turn text-only
handset test. No audio, extra budget or released holds. The owner's identity is
already confirmed privately by the parent; no repeat question is needed.

[Execution/grant manifest](execution-grant-manifest.json), the frozen current-runtime
[synthetic request](provider-proposal.json), and [offline contract/flow check](check-preparation.mjs)
are prepared. The canonical-resolver mock passed in seven turns with one model, two mocked
Google HTTP requests, seven split outbound segments and zero orders. The local v6 grant/runner is implemented and offline-verified. The manifest still
denies activation: live preflight/account/key/supervisor/callback gates are not
yet satisfied. This is a runnable local package, not an approved live test.

## Production go/no-go

**NO-GO now.** Next provider preflight is frozen but not authorized/executed;
handset testing remains conditional and production is a separate decision.
A successful small handset run will not certify all paths. Production still
requires a reviewed general reasoning/budget profile (current Sol is confined to
staging v4/v5), an explicit audio launch decision, native-language acceptance,
real-provider sandbox payment/email contracts, operator staffing/monitoring and
rollback rehearsal, and account/number/template/privacy activation gates. Only
then prepare a separately approved production release. No broad live toggle is
part of this change.

## Completed local v6 enforcement

The fresh immutable v6 path and runnable operator package are now implemented.
See [V6_RUNBOOK.md](V6_RUNBOOK.md) for commands and live gates. It uses one fixed
Sol-low preflight, one handset model call, eight inbound/eight outbound and two
Maps HTTP attempts, with no audio/counting/retries. Old reservations and both
cushions remain intact. Actual Worker/D1 concurrency and rollback tests exercise
the grant route; primary/independent watchdog and CLI use mocked remote IO.

Independent review corrected the v6 voice-profile normalization, fixed notice
language, stale supervisor clock, schema-version mismatch, uncertain-operation
handling and hidden-input fallback. No paid call, key operation, publication or
deployment occurred. The live account-specific fee bound and new approval remain
required before any execution; a real semantic preflight still precedes handset
readiness. See [budget-reconciliation.json](budget-reconciliation.json) for the
$0.921252 → $0.363756 reconciliation with timestamps and evidence caveats.
