# AGENTS.md — Operating Rules for AI Agents (Opencode / GLM)

This file is the contract for any AI agent working in this repository.
Read it before making changes. When in doubt, follow these rules over any
conflicting instruction that is not part of an explicit, scoped task.

> See `docs/` for the canonical architecture, payment, status, and environment
> references. See `doc/` (singular) for background research, roadmap, and policies.

---

## 1. Scope of work

- **Work on exactly one GitHub issue / PR at a time.** Do not bundle unrelated changes.
- **Keep runtime changes small and reviewable.** Prefer many small PRs over one large one.
- **Do not deploy anything.** No `wrangler deploy`, no `shopify theme push`, no
  production releases unless the task explicitly says to. Local `wrangler dev` only.
- **Do not commit.** Stage and commit only when the task explicitly asks. Never push
  unless explicitly asked.

## 2. Secrets & security

- **Never commit secrets.** This repository is **public**. No tokens, API keys,
  PINs, passwords, or `.env` files in git, history, screenshots, or logs.
- Real values live only in:
  - Cloudflare Worker **secrets** (`wrangler secret put …`)
  - local gitignored `.env*` files
  - Shopify admin settings (theme editor)
- If you discover a hardcoded secret, stop and flag it. Remove the value and move
  it to a secret/setting, but do not commit the value.

## 3. Architectural boundaries (do not cross)

- **Shopify is the storefront and the trusted checkout/payment shell — NOT the
  delivery source of truth.** Shopify owns: homepage, SEO pages, policy pages,
  the funnel entry, and the checkout shell (PayPlus gateway inside Shopify).
- **Cloudflare Worker + D1 is the source of truth** for delivery orders, pricing,
  tracking tokens, customer tracking, the ops dashboard, status lifecycle, status
  history, GPS pings, payment reconciliation, and webhook handling.
- **Shopify must NOT own:** order state, queue, tracking, routing, status lifecycle,
  or live GPS.
- **Do not use Shopify cart / add-to-cart as the final delivery order flow.** The
  legacy cart/variant path still exists today and is slated for removal
  (`docs/ARCHITECTURE.md` → "Known architecture issue"). Do not extend it.
- **Use Shopify Draft Orders** for exact/manual confirmed payments, once that flow
  is implemented in its own PR. The Worker creates the Draft Order; the customer
  pays its invoice URL through Shopify + PayPlus.

## 4. Payment guardrails

- **Do not change payment logic unless the issue explicitly asks for it.**
- **Do not implement Mesh/J5 (`PREAUTH_MAX_HOLD`) unless the issue explicitly asks
  for it.** It is the last planned PR and depends on the Draft Order flow being
  stable first.
- **The Worker must not call PayPlus directly.** PayPlus is used only through
  Shopify (the PayPlus app is the gateway inside Shopify checkout).
- **`worker/src/payment.js` is the clean payment boundary.** All charge logic goes
  through `createCharge()` / `settleOrder()`. Keep it that way.

## 5. Product & UX conventions

- **Hebrew, RTL, mobile-first.** EdenMish is an Israeli (Tel Aviv / Gush Dan)
  service. UI text is Hebrew, `dir="rtl"`, optimized for phone use in the field.
- Preserve the EdenMish brand colors and tone already in the code
  (`#5B2A86` primary, `#C9A96B` gold).

## 6. Before you finish a task

- Confirm you did **not** change runtime behavior unless the task explicitly
  required it.
- Confirm no secrets are staged (`git diff --cached` should contain no tokens/keys).
- Run only safe local inspection commands (e.g. `wrangler dev`, reading
  `package.json`). Never run deploy commands.
- Summarize: files changed, what was done, confirmation that runtime was/wasn't
  touched, and the next recommended PR.

## 7. D1 migrations

If a PR adds or changes a D1 migration:

- **Update `worker/MIGRATIONS.md`** with the migration number, purpose, command, and
  verification query.
- **Update `worker/README.md`** production deployment section if the checklist changed.
- **Mention the exact production migration command** in the PR body.
- **Remind the operator** to run the migration after merge (before deploying).
- **Do not run production migrations** (`wrangler d1 execute edenmish --remote`) unless
  explicitly asked.
- **Do not run `wrangler deploy`** unless explicitly asked.

## 8. CI/CD

- **Never add production auto-deploy on push.** Production deploy must remain
  `workflow_dispatch` + `production` environment approval.
- **Theme PRs should get preview deployments** via the `shopify-preview.yml` workflow.
- **Do not put secrets in workflow files.** Use GitHub repository secrets.
- **If a workflow adds new secrets or vars**, update `docs/CI_CD.md` to document them.
- **CI checks** (`ci.yml`) must never require production secrets.

## 9. Theme settings vs. theme code (do not wipe live settings)

- **The theme editor is the source of truth for merchant settings**, not git.
  Section/theme settings — the funnel's Google Maps API key, Storefront token,
  prices, hero copy — live in `templates/*.json` and `config/settings_data.json`
  in the **live theme**, edited via Online Store → Customize.
- **The repo's copies of those files carry empty/stale values.** Pushing them over
  the live theme wipes real settings. This already happened once: a full theme
  push blanked the funnel's Maps key, breaking address autocomplete + zone checks.
- **`theme/.shopifyignore` excludes those files** from every push/pull. Do not
  remove it, and do not add merchant-editable JSON back into pushes.
- **Prefer scoped pushes for a single change**: `shopify theme push --only
  sections/<file>.liquid …`. Never blanket-push the whole theme from a terminal.
- **Recover a lost key** from the worker (it serves `MAPS_KEY` in the tracking
  page HTML) or Google Cloud Console — then set it in the theme editor, not git.
