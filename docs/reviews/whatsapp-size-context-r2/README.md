# WhatsApp size-context revision 2 — review handoff

This package is for draft PR #306 on `feat/whatsapp-booking`, targeting `develop`.
It publishes the dependency-complete local implementation for independent review.
No deployment, activation, provider request, credential access, migration against
remote databases, real order/payment or customer message was performed for this
publication. Closed grants and historical reservations are not new authorization.

## Scope and dependency baseline

The preceding unpushed commit `e01da8d0c2b53ec427bad94d310a11889110b5c8`
contains the bounded second-window implementation (migration 042). It was inspected
and is included in this push without rewriting it. This publication adds 67
runtime/test/documentation files relative to that commit, plus this review package.
It excludes unrelated onboarding changes and generated Python cache files.
No package/dependency lock, deployment configuration, workflow, payment module,
production binding or customer data is added or changed.

The size-context fix depends on the currently uncommitted proposal diagnostics,
route evidence, multilingual intake, item-note retention, voice transport and
Worker/D1 test fixtures. Those dependencies are included so a clean checkout can
run the same tests. The baseline also includes migrations 043–046, fixed historical
continuation profiles, the bounded failure notice policy, and standalone synthetic
reasoning/replay tools. Review those gates independently; publishing their code
is not permission to invoke them.

## Revision 2 behavior

- Reject short size quotes that discard item negation, alternatives, retractions,
  another item/size, or weight evidence, including punctuation and mixed languages.
- Check bounded Hebrew, Arabic, Russian, French and English vocabularies together,
  regardless of reply language. Preserve an adjacent noun for adjective-only quotes.
- Accept common time/contact alternatives and negative delivery notes when they do
  not contradict the item. Preserve explicit or previously collected notes.
- Preserve exact source grounding, route-role validation, deterministic service
  rules, current explicit confirmation and canonical order/payment authority.
- Cover 86 review fixtures in validator, typed draft and signed MM voice paths:
  258 tests. Four bare-size voice controls bypass Sol; the other 82 mock Sol.
  Rejections keep item fields unchanged; these paths create no orders.
- The old `my keys; your keys` grounding case now rejects for size because another
  item is discarded. Unique-longer-quote grounding remains covered using notes.

The public regression examples are synthetic. Before this rerun, the older exact-
message wording was replaced with a synthetic equivalent in typed/voice fixtures;
no private chat transcript or private review link is published. Audio fixtures
are locally generated one-second tones, not customer recordings.

## Fresh validation of the publication snapshot

Tests ran from a clean temporary export of the Git baseline plus the exact selected
files. Existing installed dependencies were reused; no install or paid provider
call was needed. The environment explicitly set `API_URL=''`, disabled Wrangler
metrics/logging and supplied no provider credentials. The full raw stdout/stderr
is tracked below, including expected mocked-error diagnostics. No test output was
removed. `commands.json` records working directories, commands, timestamps and
exit codes; paths are relative to the snapshot root.

| Check | Result | Full output |
| --- | --- | --- |
| Worker `npm test` | 1,186 passed; 65 suites; 0 failures/skips | [worker.log](worker.log) |
| Focused validators | 299 passed; 0 failures/skips | [focused-validator.log](focused-validator.log) |
| Supervisor | 8 passed | [supervisor.log](supervisor.log) |
| Storefront `npm test` | 174 passed; 0 failed; live API suites disabled | [storefront.log](storefront.log) |
| Storefront syntax | All 13 inline scripts passed | [storefront-syntax.log](storefront-syntax.log) |
| Worker source/script syntax | All checked files passed | [worker-syntax.log](worker-syntax.log) |

Exact commands:

```sh
node --test worker/tests/whatsapp-booking-quotes.test.js worker/tests/whatsapp-size-context-review.test.js worker/tests/whatsapp-size-context.test.js worker/tests/whatsapp-live-regressions.test.js
(cd worker && npm test)
python3 worker/scripts/test-whatsapp-session-supervision.py
(cd storefront && API_URL='' npm test)
(cd storefront && npm run syntax-check)
for file in worker/src/*.js worker/scripts/*.mjs; do node --check "$file"; done
```

The 299 focused tests overlap the full Worker run; do not add them to the Worker
count. The storefront API suites are disabled without `API_URL`; the TAP runner
reports 174 executed unit tests and zero skipped leaf tests. Shopify/theme and
version checks are unchanged and are verified separately by PR CI.
[publication-manifest.json](publication-manifest.json) contains SHA-256 hashes of
all 67 selected files. The five revision-2 files from the private incremental patch
are represented directly in Git; that patch must not be applied on top again.

## Publication and deployment safeguards

The commit starts with `[CF-Pages-Skip]`, the Cloudflare-specific supported prefix,
to suppress the automatic Pages preview while retaining GitHub CI. Worker staging
runs only for `develop` pushes or manual dispatch; production is manual; Shopify
preview requires a theme PR to `main`. None is triggered by this feature-branch
review push. No settings are changed. See [Cloudflare's documented skip prefix](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#skipping-a-build-via-a-commit-message).

## Remaining review and release gates

Independent re-review is pending. Bounded lexicons are not complete multilingual
semantic understanding: unlisted items, dialects and indirect corrections can be
missed; whole-turn weights and some corrections remain conservatively rejected.
An uncertain model result still stops the paid grant. This revision does not add
clarification retries or change the stop policy. Real transcription response shape,
speech quality, native-speaker copy quality and end-to-end latency remain unverified
by these mocked tests. A typical 2–3 second reply is a target, not a measured claim.

Before another handset test: independently review the code, authorize a separate
staging deployment, reconcile retained reservations, prepare a fresh immutable
bounded grant/profile and secure temporary-key handoff, verify OFF state and both
shutdown controls, then coordinate callback/activation. Do not reuse a closed grant.
No production release or new budget is authorized by this handoff.

## Future migration checklist (documentation only)

After merge, an authorized operator must inspect and apply any missing prerequisite
migrations before a separately approved deployment. This PR must not auto-apply
pilot migrations or enable booking. Exact new production commands, from `worker`,
are listed for review only and were **not executed**:

```sh
npx wrangler d1 execute edenmish --remote --file=./migrations/042_whatsapp_continuation_followon.sql
npx wrangler d1 execute edenmish --remote --file=./migrations/043_whatsapp_continuation_retry.sql
npx wrangler d1 execute edenmish --remote --file=./migrations/044_whatsapp_continuation_sol.sql
npx wrangler d1 execute edenmish --remote --file=./migrations/045_whatsapp_voice_budget.sql
npx wrangler d1 execute edenmish --remote --file=./migrations/046_whatsapp_voice_session.sql
```

See [MIGRATIONS.md](../../../worker/MIGRATIONS.md) and
[Worker README](../../../worker/README.md) for prerequisite and schema verification
queries. Preserve all grant/operation history. Production activation remains a
separate decision.
