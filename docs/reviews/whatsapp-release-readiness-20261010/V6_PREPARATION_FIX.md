# V6 preparation fix — local candidate, no live authorization

Base: `7372c4639f575eff47436a149ca9e41c3d24748a`, branch `feat/whatsapp-booking`.
Candidate source fingerprint: `9463b47cce9e4ff77e49cb3640f6ae67789187f4d1a30630d14862b7a9de835f`.
This supersedes the runtime fingerprint in the historical RC3 source manifest for
any new v6 approval/proof; it does not change the deployed OFF receipt.

## Cause and fix

The old verifier allowed the former scheduled-job list and rejected the actual
RC3 `crons:[]`. Preparation also assumed eleven booking-profile prerequisites
survived the separate OFF configuration. RC3 intentionally removed them.

The verifier now requires explicit empty crons and checks email, generic-template,
voice, dispatch and routing isolation. The separately gated preparation path
restores the exact profile, validates OFF/active/cleanup outputs before writing,
and preserves unapproved/exclusive/private artifacts. Missing provider/account
metadata and generated variable overflow fail before artifact creation. Worker entry now expands one fixed non-secret v6 profile; unknown, wrong-scope
or conflicting profiles disable automation. Pricing, provider payload, budget,
migration and frontend are unchanged. No credentials enter this profile. Invalid profiles also disable all older paid
readiness approvals; the regression preserves legacy behavior when no compact
profile is configured.

## Verification

- 1,261 Worker tests / 65 suites pass with external IO mocked and API_URL empty.
  The sandbox-only attempt could not bind local workerd; the permitted local
  loopback rerun passed, without contacting providers.
- 33 focused CLI/preparation/SQLite tests pass; an independent reviewer reran all
  33 using the exact private RC3 OFF JSON, with no secret values or transcripts.
- Six new regression tests also pass against the sanitized 36-variable fixture.
- The generated environment alone, plus synthetic secrets and local DB, passes
  actual issuance/active/booking readiness. Tests apply exact migration047 to the
  prior schema, seed closed synthetic history, issue once, reject replay, enforce
  expiry/stop, retain history and create zero orders.
- Local Wrangler dry run succeeds from the actual RC3 base. It is not a deployment
  or verification of the account's variable limit.

The runtime tests deliberately do not merge the fixture environment into generated
settings; that would hide precisely this missing-profile defect. Source, request,
amount, immutable history and privacy boundaries remain enforced.

## Remaining capacity and owner facts

The current active Worker and account both report usage model `standard`. The
read-only billing subscription endpoint returned access error10000 and the
accessible entitlement list does not name a variable allocation. We do not claim
a separately verified billing subscription tier or request expanded permissions.

The compact preparation path avoids that uncertainty: **52 plain variables + ten
existing secrets + one temporary model secret =63**, below even the Free limit64.
Only the eleven fixed, non-secret v6 prerequisites are grouped under
`WHATSAPP_BOOKING_REVIEW_PROFILE=v6-text-20261010`. All existing unrelated plain
variables and secret bindings are retained. The CLI counts current secret names
and reserves the temporary slot before setup/activation, failing closed above64.
The profile alone cannot switch the three automation flags ON, bypass a matched
preflight, alter history/budgets or extend the fixed window. Existing profiles
without the new setting keep their behavior.

Read-only capacity receipt: [variable-capacity.json](variable-capacity.json).
No consolidation is performed remotely; deploying this candidate still requires
the single consolidated approval below. No plan change or upgrade is needed.

Also still required: non-secret owner confirmation that the existing staging
Places key came from the reviewed staging key/project, and identification of the
existing OpenAI key's funding project/organization and billing country. Never
retrieve or share either key to establish these facts. Ops sign-in is complete.

## One consolidated subsequent approval scope

After these facts are resolved, ask once for the exact reviewed fix publication to
draft PR306 (no merge), OFF staging configuration deployment and staging-only
migration047, plus a $0.35 reservation within the original $2 cap. Keep the prior
$1.636244 held: aggregate allocation $1.986244, remainder $0.013756. No refund/reset.

The authorized execution package would permit one synthetic GPT-6.1 Sol low/default
preflight (1,024 output tokens including reasoning, no counting/retry), then only
on strict semantic success one fresh immutable v6 owner-only 15-minute handset
window: eight inbound, eight outbound segments, one model call and two Maps HTTP
requests. Require a fresh hidden key handoff, two live shutdown processes, verified
browser grant/callback and future Israel interval; no clock starts during setup.
Keep the existing one-shot failure notice/grace and quota/expiry/operator-stop
limits. Cleanup clears window/flags, removes temporary key and browser callback.
No production, audio, order, payment, email, driver, wallet, marketing or private
transcript actions. This is a bounded demonstration, not general dialogue coverage.

No new publication, deployment, migration, key action, paid provider request,
grant or WhatsApp message occurred. Authorized Cloudflare metadata GETs verified
the active RC3 version, OFF flags,36 text variables,10 secret binding names/types
and absence of the temporary key; no secret value was requested or retained.
The existing browser callback cleanup receipt remains the latest browser observation.
