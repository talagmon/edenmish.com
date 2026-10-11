# Offline semantic-mismatch diagnosis and value-free instrumentation

Local follow-up to commit98bfa6b. No publication, deployment, provider call, key
installation or grant is authorized by this change. The deployed r2 source,
failed proof, request fixture, approval envelope and existing reports stay intact.

## What the real attempt establishes

The one approved r2 request failed `semantic_mismatch`, after strict proposal
validation succeeded. Provider latency8500ms, runner end-to-end9781ms;
input1181/cached0/output149/reasoning0. Low effort was pinned in the exact
request. Zero reported reasoning tokens does not prove that the setting was
ignored; this one measured reply did not meet the proposed2–3s latency target.

The runner's final gate compares version4, presence of a validated reply style,
update intent, Hebrew reply and exactly nine expected normalized field entries.
The historic report does not distinguish these branches and retains no raw
response. The historical mismatching field/attribute is therefore unknown.
Neither a model extraction defect nor a specific oracle defect can be assigned
to that response. No private transcript was accessed or used.

## Reproduced oracle defects and normalization boundaries

Using the SAME public synthetic customer message and the actual strict validator:

| Supplied proposal variation | Validator | Literal oracle | Draft behavior with mocked providers |
|---|---|---|---|
| Baseline nine fields | Accepts | Matches | Existing baseline |
| Size and notes share the complete `מעטפה קטנה עם מסמכים` quote | Accepts | Notes mismatch: expects only `מסמכים` | Retains complete item notes and reaches address review |
| Pickup detail quotes `באיסוף אצל השומר` | Accepts | Pickup-detail mismatch: expects `אצל השומר` | Retains the access instruction and reaches address review |
| Delivery detail quotes `לנועה.` | Accepts | Delivery-detail mismatch: expects `לנועה` | Retains recipient and reaches address review |

The prompt explicitly permits identical full item evidence for size and notes;
the oracle currently rejects that valid choice of evidence. This is a demonstrated
false-negative path in the test oracle, not proof of what the provider returned.
The other two paths show that the comparison tests exact wording more strictly
than the product's free-text detail fields. No Maps/model/quote network calls
are used to establish these results; all provider services are mocked.

Hebrew route-marker-inclusive/exclusive evidence is already normalized by the
role validator, and both forms pass the same oracle. Surrounding quoted spaces
are trimmed only after exact source grounding. Invented spelling, swapped route
roles and a partial size-adjective quote from this particular complete message
remain rejected BEFORE the semantic comparison. That adjective example cannot
explain the observed `semantic_mismatch` in this fixture.

The standalone Hebrew-size alias and schedule parsers do further canonical
normalization during draft processing. This does not authorize global text
folding, translation or fuzzy equality in the preflight. The synthetic fixture
uses its pinned12October Israel clock; relative dates are evaluated against that
clock, not the wall clock of the provider invocation. Future live input uses
actual current time. Date/daypart selection and final address confirmation remain
separate from extraction.

## Local integration and narrowly bounded equivalence

`worker/scripts/whatsapp-review-semantics.mjs` preserves the original literal
comparison and emits only fixed booleans, allowlisted field names and counts.
The new `whatsapp-review-fixture-oracle.mjs` wraps that comparison for exactly
one pinned synthetic fixture. `whatsapp-review-r2-runner.mjs` invokes it only
AFTER the unchanged strict evidence validator accepts the proposal.

The synthetic test acceptance is intentionally broadened; real booking evidence
validation, normalization and draft behavior are unchanged. These are the ONLY
allowed values for the three detail fields:

| Field | Explicit permitted values |
|---|---|
| notes | `מסמכים`; `מעטפה קטנה עם מסמכים` |
| pickup_detail | `אצל השומר`; `אצל השומר.`; `באיסוף אצל השומר`; `באיסוף אצל השומר.` |
| dropoff_detail | `לנועה`; `לנועה.` |

Every differing detail must itself be the actual grounded field quote (after
the validator's existing trim). There is no generic punctuation stripper,
label removal, fuzzy matching, Unicode correction or paraphrase acceptance.
The complete item phrase is grounded shared size/notes evidence permitted by
the prompt. Added punctuation is limited to the existing sentence-ending
period in the source, not invented punctuation or removal inside an instruction.
All other fields—including customer identity, email, pickup/dropoff and full
date/daypart—must match exactly after existing validation. All nine unique
fields remain required, with no missing/extra/duplicate fields.

The wrapper independently pins the request-body hash, sorted expected-value
hash, synthetic state and fixture clock. Different messages, modified expected
values, state/context or time fail this fixture gate. The generic exact helper
remains available for diagnostics; its original checks are retained in reports
even when a permitted equivalence succeeds. Additional report values are only
`fixtureBound`, `equivalentEntries` and fixed `equivalentFields` names. No
quotes, contents, names, arbitrary model keys or other field values are logged.

Diagnostics cannot turn uncertain settlement into matched status. Invalid
evidence never reaches the comparator. Both helper names are covered by the
existing `whatsapp-review-*` source-fingerprint prefix. Old approval/source pins
refuse the changed source, and the immutable failed r2 ID cannot be retried.
No booking runtime, pricing, order, payment, schema or historical report changes.

## Tests and limits

Tests exercise all16 permitted wording combinations; all512 subsets of expected
fields; order invariance; wrong version/style/intent/language; missing, different,
extra and duplicate fields; redaction; strict rejection; uncertain settlement;
no retry; and the three original oracle false-negative examples through actual
draft processing. Negatives include changed/shortened customer names, altered
recipient, invented punctuation, changed/swapped addresses, omitted day or
daypart, incomplete access instructions and modified fixture/context/clock.

Independent code review passed113 focused tests. Final full-suite evidence is
recorded in the external consolidated review bundle. This closes the demonstrated
oracle gap only; the exact historical r2 mismatch remains unknown. Real-provider
reliability and latency have not been reevaluated.

The proposed next paid scope and local five-exchange rehearsal are documented in
`NEXT_EXECUTION_PROPOSAL.md`. That document is not authorization. Fresh immutable
proof/grant controls are still required; none are created by this patch.

## Retained accounting

| Component | USD |
|---|---:|
| Prior holds/cushions before r1 | 1.636244 |
| Failed r1 hold retained | 0.056320 |
| Failed r2 hold retained | 0.056320 |
| Total retained | 1.748884 |
| Unused conditional v7 handset allocation | 0.249920 |
| Still-unallocated original margin | 0.001196 |
| Original cap | 2.000000 |

Remaining headroom is $0.251116, of which $0.249920 is still allocated to a
conditional handset run whose prerequisite failed. This is not automatically
available for another preflight. No historical hold or cushion is released;
actual provider billing is not substituted for reservations. The original
authoritative r2 receipt confirms zero v6/v7 grants and operations. Staging OFF,
key absent and window blank were verified after the failure. No new remote
read or mutation is performed by this offline follow-up.

## Combined local r3 continuation preparation

The oracle change is now packaged with a fresh additive migration049, immutable
r3 proof and version8 grant controls. These preserve the two closed failures and
all prior holds. The exact scope and one combined approval question are in
[NEXT_EXECUTION_PROPOSAL.md](NEXT_EXECUTION_PROPOSAL.md); the current model,
request limits, timing interpretation and <5s useful-reply target are audited in
[MODEL_LATENCY_AUDIT.md](MODEL_LATENCY_AUDIT.md). Runtime evidence/business
validation, model request, token/time limits and payment/order logic are unchanged.
The new runtime behavior only recognizes the separately gated version8 scope.

Validation: full Worker suite1582 passed/65 suites, focused r3+flow84 passed,
actual Worker/D1 mock integration3 passed, user-controlled 1Password helper8 mock
tests passed, Worker/review-script and storefront syntax checks passed. These are
local tests; no new provider execution or live quality/latency claim is made.
No key was accessed, no remote state changed, and no commit/push/deploy occurred.
