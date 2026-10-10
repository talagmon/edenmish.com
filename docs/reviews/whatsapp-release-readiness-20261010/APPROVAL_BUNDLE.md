# Exact approval bundle — original $2 ceiling

Status: **runnable offline-verified package; live execution not approved**. This replaces the
$1.10 estimate in the initial readiness review. It does not use or enlarge a later
voice allowance. No paid request, key operation, grant, deployment or send occurred.

## Accounting reconciliation (USD)

| Retained item | Amount | Evidence |
| --- | ---: | --- |
| Parent's earlier used/held checkpoint, including initial Sol-low $0.078848 hold and existing cushions | 1.078748 | Earlier parent checkpoint; original remaining 0.921252 |
| Later stopped synthetic batch B | 0.078848 | Sanitized immutable report/manifest; semantic mismatch; no refund |
| Later description batch C, low plus medium | 0.077528 | Sanitized immutable report/manifest; both calls retained |
| Closed v4 handset | 0.000000 | Zero operations in closure receipt |
| Closed v5 handset | 0.121120 | Fresh numeric staging D1: 3 inbound, 3 outbound, 1 model; includes model hold 0.056320 |
| v5 fee/audio reserve retained in full | 0.280000 | Fee cushion 0.25 plus unused audio allowance 0.03; zero audio calls |
| **All retained** | **1.636244** | Original 0.50 fee cushion already included in the earlier checkpoint |
| **Remaining under original 2.00** | **0.363756** | No released holds, no transferred/refunded cushion |

Dated approval/report/closure evidence and SHA-256 fingerprints are recorded in
[budget-reconciliation.json](budget-reconciliation.json). Batch B approval was
2026-10-10 09:08:14Z; batch C approval 10:13:37Z. Their reports were last written
09:30:51Z and 10:14:28Z respectively (filesystem timestamps, not provider event
timestamps). v5 closed at12:01:02Z and its final numeric audit was12:01:07Z.
The original batch A report has no embedded event timestamp; its file mtime is
2026-10-09 18:47:09Z. No transcript was used to reconstruct these amounts.

The older 0.921252 balance was correct at that earlier checkpoint. It is not the
current available balance. We conservatively count even the later voice holds
against the original ceiling here; the separate historical voice approval is not
needed to fund this proposal. **Released holds: $0.00.** Successful cheap responses
are not grounds to replace retained reservations with measured estimates.

| New bounded activity | Cap | Retained reservation |
| --- | --- | ---: |
| Synthetic preflight | 1 Sol-low generation | 0.056320 |
| Handset interpretation | 1 Sol-low generation | 0.056320 |
| Owner inbound messages | 8 | 0.082400 |
| Outbound replies, including any failure notice | 8 | 0.090400 |
| Maps network requests, including fallback attempts | 2 | 0.064000 |
| Audio/transcription, counting calls, retries | 0 | 0.000000 |
| **New planned maximum** | | **0.349440** |
| **Requested new allocation** | | **0.350000** |
| **Aggregate with whole new allocation retained** | | **1.986244** |
| **Still unallocated below original $2** | | **0.013756** |

The existing $0.78 cushions remain retained. These are strict application
reservation/operation limits and conservative cost allowances, not a provider
account-wide invoice cap. Unsolicited inbound or unrelated account usage cannot
be capped by our Worker. No additional service, premium tier, templates or add-ons
are requested. Account-specific mandatory taxes/fees must be bounded by retained
cushions before activation; unresolved billing requirements block activation.

## Official tariff verification — 10 October 2026

- [Sol model pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol):
  Standard input $2/M, cache write $2.50/M, cached input $0.10/M, output $10/M.
  Each reservation uses the higher input tariff, no cache discount, 16,384 input
  allowance and 1,024 output limit, plus 10%: $0.056320. The input allowance is an
  engineering bound, not a provider-enforced tokenizer cap.
- [Reasoning limits](https://developers.openai.com/api/docs/guides/reasoning):
  `max_output_tokens` includes reasoning and visible output. Incomplete responses
  may still cost money; reject and stop, never truncate JSON or retry.
- [Twilio pricing](https://www.twilio.com/en-us/whatsapp/pricing): $0.005 per
  inbound/outbound message; official Israel selector currently lists service
  fee $0.0053. Retain $0.0113/outbound including the published $0.001 failed-message
  allowance. Retain the older larger $0.0103/inbound reserve. Do not rely on free
  quotas. The Israel value was checked in the public page's `value="IL"` option,
  `data-service-rates`; no authenticated account access was used.
- [Google pricing](https://developers.google.com/maps/billing-and-pricing/pricing):
  Text Search Pro $32/1,000, Place Details Pro $17/1,000, Geocoding $5/1,000.
  [Requested field masks](https://developers.google.com/maps/documentation/places/web-service/text-search)
  fit the Pro category. Reserve the highest relevant $0.032 per actual HTTP
  request; a fallback consumes a second slot. No free-tier assumption.
- [Transcription pricing](https://developers.openai.com/api/docs/models/gpt-transcribe):
  $0.0045/minute, verified but **not authorized in this reduced plan**. Audio stays
  OFF and the previous unused audio reserve is not released.

Meta's direct rate-card page returned HTTP429 during verification. Twilio's own
current Israel selector supplied the service rate; do not substitute older claims
that all service replies are free. Account-specific mandatory taxes/surcharges for the EdenMish Twilio billing
account, and whether provider prices include applicable tax, remain unverified.
No authorized billing/browser connector is callable here, and no token was
retrieved to work around that limit. The browser coordinator must supply a
read-only fee bound within retained cushions before a paid run. No billing settings or support ticket changed.

## Frozen test and model

`execution-grant-manifest.json` is the explicit policy contract.
`provider-proposal.json` contains one synthetic request built with the current
runtime context/schema. `prepare-proposal.mjs` validates its expected evidence;
`check-preparation.mjs` checks accounting, every activation gate, and the full
mocked flow within the eight-turn cap. Both have zero network calls. Request size: 6,448 bytes;
SHA-256: `0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3`.

Both allowed model requests use **gpt-6.1-sol / low reasoning / default tier**,
`store:false`, no tools/history, 8,192 request bytes, 32,768 response bytes,
1,024 output tokens including reasoning, 16,384 input allowance, and a 10-second
abort deadline. No none mode, medium comparison, counting endpoint or retry.
Reject wrong model/tier, missing usage, over-limit usage, refusal, incomplete
response, invalid evidence/schema, or semantic mismatch. Keep full reservation.

The synthetic preflight supplies a small envelope description, a typo route,
tomorrow morning, a fictional name/email, recipient and access detail. It must
return all expected fields through strict canonical/evidence validation before
handset setup continues. This single case cannot establish general model quality.

## Participants, data and user script

Dedicated sender: **+97233826779**. Exactly one recipient: the previously verified
owner, bound privately by the coordinator (full number intentionally absent from
public repository files). The parent explicitly supplied both identities; no
repeat identity confirmation is needed. Public sender +972534058498 is untouched.

- Twilio/Meta receive sender/recipient numbers and test chat text to transport it.
- Cloudflare Worker/D1 receive the webhook and retain bounded draft/operation data
  under existing retention rules. Logs remain content-free diagnostics.
- OpenAI receives only the current consented message and bounded context/schema;
  no stored customer values, sender phone, full chat history, credentials or
  payment details. Synthetic data/public addresses only.
- Google receives the public address strings required for resolution.
- GitHub receives only the reviewed code, synthetic fixtures and public reports;
  no owner number, private coordination manifest, raw transcripts or credentials.
- Shopify/PayPlus, email providers and driver clients receive no test actions.

The single 15-minute handset window starts only after setup. Announce its exact
Israel start/end before activation and do not extend it. Owner sends at most:
1. Greeting.
2. Explicit policy consent with the displayed choice.
3. One complete natural booking message (prepared fictional details/public
   addresses; “tomorrow morning,” no rigid date/time format).
4–5. Address choice numbers if proposed.
6. Suggested service-rule slot number.
7. Address-summary confirmation.
8. Final-summary confirmation, which ends in conversation-only handoff.

The initial candidate-path mock used eight turns. The strengthened check runs the
actual canonical address resolver with mocked Google HTTP responses: seven turns,
one model invocation, two HTTP requests and seven outbound segments counted by
`splitBookingReply`. Real Maps responses may require fallback requests; every
HTTP attempt counts toward two and shortage stops the test. Deterministic numbers do not spend another model call. If extra
clarification/model/Maps work is needed, stop rather than increase limits. No
live correction/voice/location/language matrix is claimed here: these remain
covered offline or await a separately budgeted evaluation. Actual suggestions
are service-rule-valid, not a promise of driver capacity.

## Key, grant and coordinated shutdown contract

1. Publication scope is the explicit `publication-scope.json` allowlist on existing
   `feat/whatsapp-booking`, draft PR306 to develop. No unrelated onboarding files,
   secrets, private outputs, merge or production publication. Use the Pages-skip
   convention; verify CI and no automatic deployment before any staging step.
2. Stage the reviewed Worker and Ops UI with intake/sending/model/voice/dispatch
   OFF and incoming callback blank. No key is fetched or added during preparation.
3. Following approval, the user uses the existing hidden-entry process. Preflight
   key lives in process memory only, never argv/env/logs/files. Remove reference
   on success/error. If handset proceeds, a separately confirmed hidden handoff
   may install only the temporary staging booking-key binding. It is removed at
   stop/expiry or any setup failure. No persistent key decision is implied.
4. Allocate preflight once to the exclusive durable D1 preflight ledger before provider IO.
   Record only request/source fingerprints, counts, usage and bounded diagnostics.
   Unknown outcome stops the batch permanently. Write success proof only after
   exact semantic and usage checks; no old batch or grant is reopened.
5. A **new immutable v6 grant** must enforce the prepared contract: old v1–v5
   rows/history unchanged; retained baseline after preflight $0.912564 plus $0.78
   cushion; one model, eight inbound/eight outbound, two Maps, no audio; at most
   $0.293120 new handset holds. Reserve each operation atomically before IO,
   bind source/request/allowlist/window, reject replay and never refund holds.
6. Start a primary supervisor polling only numeric/status data every 5 seconds
   (every second during notice grace), plus an independent deadline watchdog.
   Confirm both process identities/heartbeats before granting or connecting the
   callback. Read failure, history/config drift, unknown outcome, operator stop
   or expiry triggers cleanup. Using the sole model/Maps slot must not itself
   stop deterministic menu replies; only another requested operation is denied.
7. Coordinator/browser verifies authenticated Ops/account/sender and blank
   callback, then issues exactly one grant action. Verify the authoritative row
   before callback connection; an uncertain click is not retried. Callback is
   `https://ops-staging.edenmish.com/webhooks/twilio/booking`, POST, dedicated sender
   only. Fallback stays blank and existing status callback remains unchanged.
8. Verify persisted callback and deployed limits. Activate no earlier than the
   announced start. Coordinator announces START only after authoritative checks;
   no synthetic WhatsApp probe is sent.
9. Model failure stops normal automation. At most one exact fixed pause notice
   may consume a remaining outbound slot and $0.0113 hold. Cleanup can wait at
   most 30 seconds for it, never beyond expiry. Operator stop, unavailable slot,
   budget shortage or uncertain prior send suppresses it; no retry.
10. A normal completed handoff first settles its already queued completion reply
    (sent/failed/uncertain, no retry) within the existing 10-second send deadline,
    remaining outbound quota and session window. Do not start another send in
    cleanup or wait for a delivery/read receipt. Operator stop/expiry interrupt
    immediately; this ordinary-send wait never extends either. If the pending
    reply cannot settle within that bound, stop and retain the uncertainty.
11. After that bounded handoff disposition, operator stop, any unsafe/unknown state
    or hard expiry: disable all
    flags, clear window, remove temporary booking key; browser clears incoming
    callback and verifies blank after completed save/reload. Independent watchdog
    invokes the same idempotent cleanup. Preserve all ledgers; verify no
    order/payment/email/driver changes, key absent and OFF metadata. Do not claim
    callback removal from an attempted save alone.

Exact allowed notice: “לא הצלחתי לעבד את הפרטים. האוטומציה נעצרה. אפשר לפנות לנציג להמשך.”

## Activation blockers and precise publication boundary

The complete local package passed 1,254 Worker tests, 175 storefront tests,
8 legacy supervisor tests, and syntax checks (73 Worker source/scripts and
13 storefront scripts). V6 adds 57 tests, including actual Worker/D1 concurrency
and guarded CLI/runner boundaries. Independent final CLI recheck:16 passed,
with no remaining reported scoped implementation blocker.
**The local package now implements v6 enforcement, migration047, the exclusive
preflight runner, primary supervisor, independent watchdog and guarded operator
CLI.** It is runnable offline and has dedicated concurrency/rollback, budget,
expiry, schema/evidence, key-handling and final-reply tests. See
[V6_RUNBOOK.md](V6_RUNBOOK.md). No remote migration/deployment/call has occurred.
The immutable grant must never be substituted for a previous window. Its prior
voice/audio table freeze is dedicated-staging-specific, not a production design.


Other gates held false in the manifest: explicit approval, real preflight pass,
account fee bounds, ephemeral key, authoritative grant, two supervisors, current
callback and fixed future window. Any false gate prevents activation. A
coordinator may present the bundled conditional request below; preparation alone
cannot enable paid execution or WhatsApp.

## Independent findings / production blockers

- Confirmation: voice alias bypass fixed and independently rechecked; typed final
  confirmation required. No operator action represents a paid or executed delivery.
- Partial/address UX: failed-address field loss and candidate-correction block
  fixed; other invalid-field short circuits and conservative mixed-item rejection
  remain. Real provider completion/clarification quality is not established.
- Model/latency: strict Sol low and medium synthetic observations exist; no broad
  accuracy result, measured typical 2–3s reply time or WhatsApp end-to-end result.
  Sol production profile/general budget controls remain absent.
- Audio/languages: simulated format/consent/negation/language tests pass; no real
  latest-session transcription, native-speaker acceptance or production audio
  profile. This reduced test does not authorize them.
- Location: unsafe label handling fixed; address-pin resolution unsupported.
- Pricing/checkout: canonical mocked price/expiry/race/idempotency tests pass;
  separately scoped provider sandbox payment/email contracts still needed.
- Ops: OFF-state recovery fixed, with auth/origin and uncertain-invoice close
  checks; staging UI acceptance, staffing, alerts and recovery drills remain.
- Transport/operations: signed/replay/concurrency tests pass; fresh account,
  verification, template/coexistence and privacy activation checks remain.
- Dispatch: mocked paid reconciliation enters canonical pipeline without marking
  pickup/delivery complete; no real dispatch test or production release authorized.

The broader risk matrix and evidence remain in README.md. A successful small
smoke test does not remove these production gates.

## Exact conditional approval text for the coordinator

“Approve publishing the reviewed files to existing draft PR306 (no merge),
applying migration047 and the staging-only OFF deployment, and allocating up to
$0.35 from the original $2 cap with all prior holds retained. After account fees
are bounded within the retained cushions, run one Sol-low synthetic preflight.
Only if it passes, run one fixed 15-minute text-only WhatsApp test on the existing
dedicated sender and approved owner number: at most8 inbound/8 outbound,1 handset
model call and2 Maps requests, no retries/audio. Use temporary key handling and
two shutdown processes; allow the exact Hebrew pause notice above once within
the outbound quota and at most30 seconds before shutdown, never beyond expiry
or operator stop. No production, real orders, payments, emails, dispatch, wallet
spending or private transcript access.”

Do not present this as permission already received. Account fee evidence is a
separate unresolved fact; approval cannot substitute for it. No key action is
requested until that gate and the exact approval are satisfied.
