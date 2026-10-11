# R2/v7 operator runbook — prepared, not authorized for execution

This isolated package preserves the failed r1 proof, all prior holds and the
original $2 cap. It does not retry r1 or reopen v6. No provider call, migration,
deployment, publication, key operation or live send is authorized by this file.

## Scope and allocation

| Component | USD reservation |
|---|---:|
| Prior holds/cushions before failed r1 | 1.636244 |
| Failed r1 retained | 0.056320 |
| New synthetic preflight | 0.056320 |
| One handset model call | 0.056320 |
| Six inbound | 0.061800 |
| Six outbound segments | 0.067800 |
| Two Maps HTTP attempts | 0.064000 |
| Total | 1.998804 |
| Unallocated remainder | 0.001196 |

New allocation $0.306240 consists of transferring $0.293680 unused v6 allocation
and $0.012560 previously unallocated margin. The failed r1 $0.056320 is never
released. Conditional handset cap $0.249920; retained fee/audio cushions
$0.780000 remain unchanged. These are application reservations, not a cap on
unrelated account charges or unsolicited inbound already billed by Twilio.
Previously settled project/fee evidence is reused after freshness verification;
do not reopen settled questions without a concrete discrepancy.

Fixed proof `edenmish-release-smoke-20261011-r2`; fixed grant
`edenmish-luna-pilot-20261009-a:quote-v2-handset-7`, version7. Dedicated sender
+97233826779 and the previously approved own recipient only. No production,
orders, payments, emails, driver dispatch, audio or business-wallet actions.

Six exchanges: greeting; explicit consent; full natural details with one
misspelled pickup/exact destination; numbered pickup correction; numbered
morning slot; human handoff. It reaches address review, not final quote.
Additional ambiguity cannot expand quotas. Natural editing and partial input
requiring a second interpretation remain offline coverage only in this test.

## One combined approval, then private preparation

Obtain explicit approval for the reviewed source publication to the existing
draft PR (no merge), staging048/OFF deployment, exact allocation above, one new
preflight and conditional live test. Do not fabricate approval fields.

Use Node22. The private base is the previously verified RC3 OFF JSON with
`triggers:{crons:[]}`, dedicated staging database and no secret values. The
private plan has known `recipient`, future `startsAt` and `endsAt` milliseconds
(exactly900000 apart). Choose and announce a future Israel window only after
setup is ready; never shift an issued window.

```sh
node worker/scripts/whatsapp-review-r2-cli.mjs fingerprint
node worker/scripts/whatsapp-review-r2-prepare.mjs /private/staging-base.json /private/plan.json /private/v7-session
```

Inputs require mode600 and new private directory mode700. Exclusive outputs
`off.json`, `active.json`, `cleanup.json`, `approval.json` start unapproved. The
versioned compact profile retains52 plain variables,10 existing secrets and one
temporary slot (63 total); CLI checks actual capacity without removing unrelated
bindings. Record actual approval time/expiry, bounded existing fee evidence,
`transferredUnusedMicros:293680`, `additionalUnallocatedMicros:12560`,
`failedPreflightReservedMicros:56320` and the read-only history pin.

```sh
node worker/scripts/whatsapp-review-r2-cli.mjs pin-history /private/v7-session/approval.json
node worker/scripts/whatsapp-review-r2-cli.mjs migrate /private/v7-session/approval.json
node worker/scripts/whatsapp-review-r2-cli.mjs stage-off /private/v7-session/approval.json
node worker/scripts/whatsapp-review-r2-cli.mjs verify /private/v7-session/approval.json
```

Verify pinned failed r1, zero v6 rows, source/config/17 historical-table pins
and all gates OFF. Migration does not issue a grant. R2 reservation freezes
predecessors immediately. Proof pending/failed remains final for paid-attempt
purposes; never retry an uncertain operation.

## Single real preflight

```sh
python3 worker/scripts/whatsapp-review-r2-key-entry.py /absolute/path/to/node /private/v7-session/approval.json
```

The existing guarded user-controlled secret-entry process passes the key by
stdin only; the agent never reads Terminal/clipboard/key. No persistent-key
change is implied. GPT-6.1 Sol low/default, `store:false`, no tools/history or
counting request, no retry. The exact request hash remains
`0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3`.
Bounds:8192 request bytes,32768 response bytes,16384 input-token engineering
allowance,1024 output tokens including reasoning,10s timeout. Full reservation
$0.056320 persists on failure. Strict evidence and all nine expected fields must
pass; version downgrade/missing usage/uncertain ledger write stops the test.
Only bounded diagnostics and numeric usage/latency are retained. Low effort
does not guarantee nonzero reported reasoning tokens.

Require local report `matched` AND authoritative matched D1 proof with current
source/request hash and expiry covering the entire handset window. One pass
is not evidence of general language quality or typical speed.

## Shutdown owners, grant and browser coordination

Before handset key install/grant/callback, start separate processes:
```sh
node worker/scripts/whatsapp-review-r2-cli.mjs supervise /private/v7-session/approval.json
node worker/scripts/whatsapp-review-r2-cli.mjs watchdog /private/v7-session/approval.json
python3 worker/scripts/whatsapp-review-r2-key-entry.py /absolute/path/to/node /private/v7-session/approval.json key-install
```

Verify distinct live PIDs/heartbeats and temporary binding metadata only.
Browser coordinator verifies the authenticated Ops rendered grant7 config and
clicks once. Endpoint `POST https://ops-staging.edenmish.com/api/ops/whatsapp/pilot/continuation/grant`,
body `{grant_id:"edenmish-luna-pilot-20261009-a:quote-v2-handset-7",version:7}`.
Requires Ops auth/trusted origin. On uncertainty inspect the ledger; never retry.

After authoritative grant verification, browser connects dedicated sender's
incoming POST to `https://ops-staging.edenmish.com/webhooks/twilio/booking`,
saves once and reloads to verify. Fallback blank, status callback unchanged.
Browser receipt records verified sender/incoming/method/fallback/end/time.
Public number is untouched. No probe or test message is sent during setup.

At or after announced start, within fixed15minutes:
```sh
node worker/scripts/whatsapp-review-r2-cli.mjs activate /private/v7-session/approval.json
```
Only `activeVerified:true` permits coordinator to announce START. Grant remains
bound to source/config/history/recipient/window. Extra paid interpretation or
Maps lookup is refused. Service-rule slot suggestions do not claim driver capacity.

## Stop and receipts

Operator stop/expiry override everything. Model failure may send only the
previously approved fixed notice, using one remaining of six outbound slots:

> לא הצלחתי לעבד את הפרטים. האוטומציה נעצרה. אפשר לפנות לנציג להמשך.

Claim within15s and finish within15s of claim/30s of failure, never beyond the
window. Missing budget, operator stop, uncertainty or prior notice suppresses it.
No retry or extra notice allocation. Handoff permits only its already queued
acknowledgment to settle within10s and the remaining window.

```sh
node worker/scripts/whatsapp-review-r2-cli.mjs stop /private/v7-session/approval.json
```

Cleanup durably stops the grant, deploys pinned OFF with blank window, removes
only the temporary model binding. Both shutdown owners can invoke idempotently.
Worker checks expiry before provider IO; remote cleanup also depends on network
responsiveness. Browser separately clears callback/save/reload and verifies blank.
Record ledger reservation/counters, `grantStopped`, `flagsOff`, `keyAbsent`,
browser callback receipt and sanitized report. Do not fetch private transcripts.
Do not use stopped proof/grant as authorization for another run.
