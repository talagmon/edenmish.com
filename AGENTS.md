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
- **Agent communication is in English.** Status updates, technical explanations,
  reviews, deployment reports, and handoff messages to the repository owner must be
  written in English. Use Hebrew only for customer-facing product copy or when the
  owner explicitly requests Hebrew. Mixing Hebrew and English in agent reports can
  break word order and readability in the interface.
- Follow the **v2 design system** (canonical): dark glassmorphism, purple
  `#5B2A86` / `#dfb7ff` primary, mint `#91d3c8` secondary accent. The legacy gold
  `#C9A96B` is intentionally retired — do not reintroduce it on customer-facing
  surfaces (emails, pages). Source of truth: `edenmish-v2/design/DESIGN.md`.

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

## 8. CI/CD & branch workflow

### Branch strategy (never bypass this)

```
main     → edenmish.com (production)       [protected — PR required]
develop  → staging.edenmish.com (staging)  [integration testing]
feat/*   → <branch>.edenmish-staging.pages.dev (preview) [isolated testing]
```

### How to work (agents must follow this)

1. **Create a feature branch from `develop`:**
   ```bash
   git checkout develop
   git checkout -b fix/description   # or feat/description
   ```
2. **Commit with conventional messages:**
   - `fix: ...` → patch version bump on release
   - `feat: ...` → minor version bump on release
3. **Push and open a PR to `develop`** — never directly to `main`.
4. **Cloudflare Pages** auto-deploys a preview at `<branch>.edenmish-staging.pages.dev`.
5. **CI** (`ci.yml`) runs syntax checks on Worker + Storefront JS on every PR.
6. **After PR merged to `develop`** → `staging.edenmish.com` is updated automatically.
7. **Deploy to production is manual** (operator merges `develop` → `main`).

### Deploy rules

- **Never deploy to production.** No `wrangler deploy`, no `npm run deploy`, no
  `shopify theme push` unless the task explicitly asks.
- **Local testing only:** `wrangler dev`, `npm run serve`, syntax checks.
- **Production deploy** remains manual via `workflow_dispatch` in
  `production-deploy.yml` with environment approval.
- **Never add production auto-deploy on push.**
- **Theme PRs should get preview deployments** via `shopify-preview.yml`.
- **Do not put secrets in workflow files.** Use GitHub repository secrets.
- **If a workflow adds new secrets or vars**, update `docs/CI_CD.md`.
- **CI checks** must never require production secrets.
- **Syntax check before every PR:** `cd storefront && npm run syntax-check` and
  `cd worker && for f in src/*.js; do node --check "$f"; done`.

## 9. Theme settings vs. theme code

- **The live Shopify theme editor is the source of truth for production merchant
  settings.** These values are stored in `config/settings_data.json` and
  `templates/*.json`; repository copies may contain defaults or stale values.
- **Never include those files in a push to the live theme.** Live pushes must pass
  `--ignore "config/settings_data.json" --ignore "templates/*.json"`, as enforced
  by `production-deploy.yml`. Prefer `--only <path>` for a single-file change.
- **Preview and unpublished-theme pushes must remain complete.** They may include
  the JSON files because a new preview theme needs its templates and settings to
  render correctly and cannot overwrite the existing live theme.
- **Do not add a global `theme/.shopifyignore` for these paths.** Shopify CLI
  applies it to preview/unpublished pushes too, which would produce incomplete
  preview themes.
- Recover any lost setting from its authoritative admin or secret store, then
  restore it through Shopify's theme editor. Never copy secret values into git.
