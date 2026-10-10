# Runnable v6 package — all live actions await approval

For deployment of the disabled RC without paid-test setup, use
[RC_STAGING_PLAN.md](RC_STAGING_PLAN.md). That path defers migration047 and does
not fabricate the fee/paid approval required by the commands below.

This package is implemented and mock-tested. It has not been deployed or run
against a provider. It cannot reopen v1–v5 or a failed/pending preflight. New
provider/handset readiness remains false. The existing dedicated sender and
previously approved owner are already identified; do not ask for them again.

## Local preparation

Use Node22 and Python3.12. `whatsapp-review-prepare.mjs` takes a **private JSON**
copy of the reviewed staging Wrangler configuration (no secret values), a private
plan containing `recipient`, future `startsAt` and `endsAt` milliseconds, and a
new private output directory. If converting the existing TOML, use `tomllib` and
write JSON directly to a mode600 file; never print configuration/allowlist data.
No start time is chosen here: the coordinator announces a future 15-minute
Israel interval after setup is ready. Proof validity is one hour; include setup
and the whole handset window within it. Never shift an issued window.

```sh
node worker/scripts/whatsapp-review-cli.mjs fingerprint
node worker/scripts/whatsapp-review-prepare.mjs /private/staging-base.json /private/plan.json /private/v6-session
```

Generated `off.json`, `active.json`, `cleanup.json`, and `approval.json` are
exclusive mode600 files. Existing files are never overwritten. The approval is
**false**, fee evidence empty, all live gates unfulfilled. Configuration contains
no secret. Use only the dedicated staging database and sender, never production.
The source digest covers Worker code, these scripts, migration047 and the exact
synthetic proposal; changing them invalidates approval/proof. Preserve the
reviewed tree throughout the run.

The coordinator records the actual new human approval in `approval.json`, with
`approved:true`, `approvedAt`, `approvalExpiresAt` (max24h), account-specific
`feeEvidence`, `feesBounded:true` and a numeric maximum mandatory fee within the
retained $0.78 cushions. This is a record of received approval, **not a way to
manufacture authorization**. Do not set fee gates without evidence. Record the
numeric/history fingerprint in `priorHistorySha256` after read-only inspection.
No private transcript, sender body or credentials are needed.

```sh
node worker/scripts/whatsapp-review-cli.mjs pin-history /private/v6-session/approval.json
```

`pin-history` is a read-only D1 operation; its returned hash must match the
reviewed predecessor ledgers/accounting receipt. It does not approve a new grant.
Do not read unrelated conversations. No account-specific billing connector is
available to this implementation environment; the browser coordinator must
verify the remaining tax/mandatory-fee bound before executing a paid command.

## After approval: stage OFF and run exactly one synthetic preflight

Each command validates the private scope. Wrangler uses existing operator auth;
no token retrieval is implemented. Capture only sanitized status. No command
sends a WhatsApp probe. No uncertain paid action may be retried.

```sh
node worker/scripts/whatsapp-review-cli.mjs migrate /private/v6-session/approval.json
node worker/scripts/whatsapp-review-cli.mjs stage-off /private/v6-session/approval.json
node worker/scripts/whatsapp-review-cli.mjs verify /private/v6-session/approval.json
python3 worker/scripts/whatsapp-review-key-entry.py /absolute/path/to/node /private/v6-session/approval.json
```

The user alone enters the existing key at the hidden prompt and types YES.
Hidden input is refused when terminal control is unavailable. The key is passed
by stdin to a short-lived process, never argv/environment/file/log. The preflight
is a single Responses request, default tier, low reasoning, store:false, no
history/tools/counting/retry. Durable D1 insertion precedes IO. Failure, timeout,
missing usage, downgrade from v4, invalid evidence or any missing expected field
retains the whole $0.056320 hold and stops. Output records fixed diagnostics and
numeric input/cached/output/reasoning counts only. Zero reported reasoning tokens
can occur for low effort; it does not establish that the effort setting was ignored.

Require `preflight-report.json.status == matched` and the authoritative matched
D1 row/source/request/expiry before handset setup. A single synthetic pass is a
small readiness check, not evidence of broad language quality or typical speed.

## Fresh handset grant and coordinated activation

Start **two separate processes** before key installation or browser grant/callback
action. They can supervise the OFF state while waiting for a grant:
```sh
node worker/scripts/whatsapp-review-cli.mjs supervise /private/v6-session/approval.json
node worker/scripts/whatsapp-review-cli.mjs watchdog /private/v6-session/approval.json
```

A second explicit hidden handoff may then install only the temporary staging key:
```sh
python3 worker/scripts/whatsapp-review-key-entry.py /absolute/path/to/node /private/v6-session/approval.json key-install
```
No generation occurs during installation. A verified preflight, OFF state, fresh
independent shutdown owners and time **before the fixed start** are required.
A delayed prompt cannot install after the start/expiry. On uncertain install,
cleanup is attempted; never fetch the key back. Do not move an issued window.

Record both live PID/heartbeat files. The primary polls numeric/status fields;
no transcript is fetched. Its DB snapshot is one SQL statement, avoiding mixed
counters under concurrent traffic. The watchdog checks its fixed end every five
seconds independently of primary remote reads. Worker checks exact expiry before
provider IO; process cleanup also depends on network responsiveness and is not
claimed to be instantaneous. Source/config/history uncertainty stops the run.

Browser coordinator verifies Ops/account/sender, then clicks the displayed v6
grant **once**. Exact endpoint:
`POST https://ops-staging.edenmish.com/api/ops/whatsapp/pilot/continuation/grant`
with `{grant_id:"edenmish-luna-pilot-20261009-a:quote-v2-handset-6",version:6}`.
It requires existing Ops auth and trusted mutation origin. Verify the D1 row
before callback connection; uncertain click means inspect, never click again.

Browser alone connects the dedicated sender's incoming POST callback to
`https://ops-staging.edenmish.com/webhooks/twilio/booking`, saves and verifies after
reload. Fallback remains blank and status callback unchanged. It then writes a
private receipt with `verified:true`, exact sender/incoming/method/fallback,
`endsAt`, and `verifiedAt`. Parent retains responsibility for clearing it at stop.

No earlier than the announced start:
```sh
node worker/scripts/whatsapp-review-cli.mjs activate /private/v6-session/approval.json
```
This requires source/history/fee/approval pins, matched preflight, unused v6 grant,
key-binding presence, two fresh distinct live supervisor PIDs and the recent
browser receipt. It deploys only the pinned active staging config and rechecks metadata, the
current grant stop/window and both shutdown owners afterwards. Any uncertain activation attempts cleanup. Coordinator
announces START only on `activeVerified:true`.

## Stop behavior and limits

Eight inbound, eight outbound **segments**, one handset model and two Maps HTTP
requests; no audio. Full holds are retained, no retries. Model/Maps quota alone
must not stop the remaining deterministic numbered choices. Requiring another
paid operation cannot expand the grant. Service-rule suggestions do not claim
real driver capacity.

Final handoff allows only its already queued completion reply to settle within
10 seconds, remaining send quota and the fixed window. It does not wait for a
read/delivery receipt or create a send during cleanup. Operator stop/expiry win.
Model failure may use one remaining outbound slot for this exact fixed Hebrew
notice, independent of conversation language:

> לא הצלחתי לעבד את הפרטים. האוטומציה נעצרה. אפשר לפנות לנציג להמשך.

Claim within15s, complete within15s of claim and30s of failure, never past expiry.
No slot, operator stop, unverified failure or uncertain prior notice suppresses
it. No retry. All other automation remains stopped.

```sh
node worker/scripts/whatsapp-review-cli.mjs stop /private/v6-session/approval.json
```

Cleanup first sets the durable grant stop, then deploys the pinned OFF config
with window cleared and removes only the temporary booking-key binding. Primary
and watchdog may call it; it is idempotent. A changed cleanup source prevents
that deployment, while ledger-stop/key-removal are still attempted and failures
are reported honestly. Verify `grantStopped`, `flagsOff` and `keyAbsent`.
`callbackVerified` is deliberately false: only the browser's completed
clear/save/reload receipt can establish callback removal. Preserve ledgers even
on an unknown outcome; never lower reservations or reset the fixed proof ID.

This cannot cap unrelated account usage or an unsolicited incoming message
already billed by Twilio before the webhook. The $0.35 is a strict application
reservation allocation, not a provider-wide invoice limit. Account fees and
coordinator control of the dedicated sender remain live prerequisites.
