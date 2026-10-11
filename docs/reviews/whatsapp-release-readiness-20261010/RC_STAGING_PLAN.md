# WhatsApp RC3: stage disabled, then prove each integration

Prepared 2026-10-10 on `feat/whatsapp-booking`, base
`c6e4e5c5023833fab7df7ae6996a4b01e56657cc`. This is a local candidate, not a
published commit or deployed version. RC3 names this release candidate; v6 names
the separate immutable paid-test grant. They are not interchangeable.

## Scope and readiness

The candidate combines the reviewed conversation/confirmation/address-retention,
operator recovery and location-fallback fixes, v6 safety implementation, tests,
and the Google project documentation. Worker+D1 still owns quote/order validation;
Shopify Draft Orders still supply the existing PayPlus invoice link. Paid webhook
amount/currency/reference reconciliation still owns payment success. Payment does
not claim pickup or delivery. No canonical payment or driver implementation changed.

**Ready for an OFF-only staging deployment after publication/configuration review.**
Paid-test billing/key provenance does not block this deployment: it performs no
model, Maps or messaging test and requires no credential installation. Live text,
voice and production readiness remain separate. Do not set `feesBounded` or a
paid-test approval to get an OFF deployment through the v6 CLI.

| Area | Completed locally with mocks | Next evidence / release gate |
|---|---|---|
| Natural text | Optional numbered shortcuts, scoped written equivalents, field evidence, retained partial details, address correction/roles, keys/envelopes, vague-daypart choices, final typed confirmation | One bounded real Sol-low semantic preflight, then owner handset text run; latency/completion evidence, not model-name claims |
| Safety and operator takeover | Duplicate/out-of-order events, stale/changed quotes, no blind retries, handoff pauses, authenticated OFF-state recovery, v6 reservations/expiry/shutdown/one-notice limits | Read-only staging Ops/auth/origin acceptance; later coordinated shutdown rehearsal |
| Staging integration | Worker/D1 integration and concurrency tests; OFF-config assertions; local bundle check | Verify deployed version, source/config hashes, staging D1/routes, OFF flags, no cron schedules, no temporary model key, no grant window; no provider probes |
| User-operated text | Synthetic Hebrew full flow with canonical mocked address resolver: seven turns, one model, two Maps calls, seven outbound segments, zero orders | Approved 15-minute/8-in/8-out text-only session after real preflight; consent, typo, morning, numbered selection, correction/handoff; suggested slots follow service rules, not reserved driver capacity |
| Voice | Consent/media/type/size/duration/signature/transcription bounds and mandatory typed final confirmation covered | Separate bounded transcription/handset approval, credentials and budget; v6 text grant has zero audio allowance; voice stays OFF |
| Location | Coordinates/labels cannot act as confirmation or leak into model input; typed street/house/city fallback | Owner confirms fallback usability. Pin-to-address resolution is not implemented or claimed for RC3 |
| Quote/order/invoice/OTP | Canonical quote and one-order/one-invoice idempotency; email preservation; mocked Shopify/payment and OTP integration | Separate isolated sandbox plan with fictional data, provider test checkout, QA-only email and dispatch simulator; no real orders/payments/customer emails/driver work under this RC approval |
| Paid reconciliation/driver notifications | Signed webhook amount/currency/reference mismatch and duplicate tests; downstream Ops/outbox/route behavior mocked | Provider-signed sandbox event through isolated staging; inspect test notification sink and simulated driver actions; paid alone must not mark pickup/delivery |
| Production | Existing canonical architecture and guarded local coverage retained | Separate production profile/budget, operational staffing/alerts, privacy/retention, account/number approvals, sandbox acceptance, supported-language/latency acceptance and explicit production go/no-go; no merge/deploy now |

## OFF deployment isolation

`prepare-staging-off.mjs` is offline-only. It makes an exclusive mode600 config
from the reviewed nonsecret staging configuration. It pins the existing staging
Worker, two staging routes and staging D1. It removes inherited booking grant,
readiness, proof and window configuration; all booking/send/model/voice approvals
remain OFF. It sets `conversation_only`, keeps storage039 available for Ops,
disables dispatch/route optimization, clears recipient allowlists, blanks generic
Meta templates and sets `triggers.crons=[]`.

Pausing crons also pauses staging reminder/outbox/held-package and retention jobs.
This is deliberate for this short disabled review phase. Before any later test,
review pending jobs and the later configuration rather than restoring crons blindly.
Canonical non-booking HTTP order APIs remain present: use read-only acceptance
checks only, do not submit booking/order/payment/driver mutations. This deployment
is not a network-wide block on unsolicited Twilio traffic or unrelated API callers.

No secret upload, deletion, rotation or export is part of deployment. Before
deploying, inspect binding **names/types only**: the temporary booking model key
must be absent and the two generic Meta template names must not be existing secret
bindings (otherwise stop for a scoped configuration decision; never overwrite a
secret with a plain variable). Other existing authentication secrets are preserved.
The browser coordinator separately verifies/disconnects the dedicated incoming
callback before remote actions; do not assume its last recorded state is current.

Migration047 is **deferred** for this OFF deployment. Existing schema039 must be
verified present with numeric schema metadata. With no continuation ID/version,
OFF Ops/grant paths do not access the new v6 tables. Migration047 later creates
durable preflight/grant ledgers and freezes prior voice/audio history after v6
issuance. It is dedicated-staging-only and requires explicit approval immediately
before application. Do not add it to a broad automatic production migration.

## Exact publication and staging actions

The coordinator should bundle approval for the following concrete scope once:
commit only the refreshed `publication-scope.json` allowlist, push it to the
existing feature branch/draft PR306 (no merge), then deploy only the pinned OFF
Worker configuration. No credential or paid-test action is included. Recheck the
remote branch/PR is still the intended draft before publication; never force-push.

Proposed commit subject:
`[CF-Pages-Skip] fix: prepare WhatsApp RC3 with disabled staging rollout`

Create a NUL-delimited pathspec from the reviewed allowlist; verify every hash and
confirm unrelated onboarding files, outputs/private records and caches remain out
of the index. Then, after the coordinated publication approval:

```sh
git add --pathspec-from-file=/private/rc3-pathspec --pathspec-file-nul
git diff --cached --check
git diff --cached --stat
git commit -m '[CF-Pages-Skip] fix: prepare WhatsApp RC3 with disabled staging rollout'
git push origin HEAD:feat/whatsapp-booking
```

Record the resulting commit SHA in the deployment receipt and draft PR description.
Do not dispatch `.github/workflows/staging-worker.yml`: it applies broad migrations
and uploads a secrets file. Do not use the paid v6 `stage-off` command for this phase.
Do not deploy Pages or production; the changed Ops dashboard is bundled by Worker.

Offline preparation (Node22; existing staging TOML may be converted locally with
Python `tomllib` to private JSON without printing it):

```sh
node docs/reviews/whatsapp-release-readiness-20261010/prepare-staging-off.mjs /private/rc3-base.json /private/rc3-off.json
node --test docs/reviews/whatsapp-release-readiness-20261010/staging-off.test.mjs
node worker/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config /private/rc3-off.json --outdir /private/rc3-bundle
```

After verifying pinned config/source/bundle, current staging target/binding names,
schema039 and blank callback, the only remote mutation in this phase is:

```sh
node worker/node_modules/wrangler/bin/wrangler.js deploy --config /private/rc3-off.json --keep-vars=false
```

Use existing operator authentication without retrieving credential values. Do not
retry an uncertain deployment; inspect its deployment/version metadata first.
Verify one current 100% version, exact staging routes/DB, cleared inherited window
variables (`--keep-vars=false`), OFF flags, empty recipients/templates, absent model
key and zero schedules. Verify Ops authentication, queue rendering and disabled
grant UI read-only; never treat login or a loaded page as provider acceptance.
Rollback is redeploying the last reviewed bundle with the **same inert OFF profile**,
not restoring a previous active config or schedules. No ledger rows are deleted.

## Minimal later owner handoffs

No owner key entry or billing investigation is needed to stage OFF.

Keep `API_URL` empty for the ordinary storefront test suite. Its existing
`?test=1` API fixtures create auto-paid test orders; they are outside read-only
RC acceptance and cannot prove provider payment reconciliation. Use a separately
approved sandbox harness for the later financial/notification acceptance phase.

Before paid testing, finish the remaining facts once: owner attestation of current
staging Places resource linkage (or separate owner-performed fresh secret entry),
and OpenAI project/funding organization billing country/provenance. The Google
credential-project and Israel/ILS billing metadata are already verified; do not
ask to rediscover them. Keep ownership attestations distinct from direct evidence.

Then request one consolidated approval for migration047, the prepared $0.35 test
allocation within the original $2 (all $1.636244 holds preserved), the existing
one-notice/expiry limits and fresh immutable v6 setup. User enters the existing
OpenAI key only through the guarded hidden helper when setup is ready. Do not
reopen old grants or repeat a stopped paid batch. A failed/unknown preflight stops.
Only after strict semantic success coordinate two shutdown processes, a fresh
fixed interval and the browser-owned callback; tell the owner START only after
verified activation. See `V6_RUNBOOK.md` for the exact later commands.

Voice and provider checkout/OTP/driver sandbox exercises are subsequent scoped
acceptance phases, with their own budget/credentials and QA destinations; they
are not silently included in the small text grant. Production remains a separate
review and owner-approved release after those required gates pass.
