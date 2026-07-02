# CI/CD

GitHub Actions workflows for EdenMish — PR checks, Shopify theme previews, and
manual production deployment.

---

## Why CI/CD exists

Merging a PR into `main` on GitHub does **not** automatically update `edenmish.com`
or the Cloudflare Worker. Three separate systems must be coordinated:

1. **GitHub** — source control, PR review, merge.
2. **Cloudflare** — Worker deployment (`wrangler deploy`) + D1 database.
3. **Shopify** — theme publishing (`shopify theme push`).

CI/CD bridges these safely: PR checks catch syntax errors before merge; theme
previews let you test on a real Shopify instance; production deploys are manual
and gated by environment approval.

---

## Workflows

### `ci.yml` — PR checks

**Trigger:** `pull_request` to `main`.

**Checks:**
- Worker: `npm install` in `worker/`, then `node --check` on every `src/*.js`.
- Theme: `shopify theme check --path theme` (non-blocking — `continue-on-error`).

**Secrets required:** none. CI runs without any credentials.

---

### `shopify-preview.yml` — Shopify theme preview

**Trigger:** `pull_request` to `main`, only when `theme/**` files change.

**Behavior:**
- Pushes an **unpublished** theme to the Shopify store using `shopify theme push --unpublished`.
- Extracts the preview URL from the JSON output.
- Comments the preview URL on the PR (updates if re-run).
- Prints the URL in the GitHub Actions summary.

**Never publishes live.**

**Secrets required:** `SHOPIFY_CLI_THEME_TOKEN`, `SHOPIFY_STORE`.

**Environment:** `preview`.

---

### `production-deploy.yml` — manual production deploy

**Trigger:** `workflow_dispatch` only (manual button in GitHub Actions tab).

**Inputs:**
| Input | Type | Description |
|---|---|---|
| `deploy_worker` | boolean | Deploy the Cloudflare Worker |
| `deploy_theme` | boolean | Push the Shopify theme (unpublished) |
| `publish_theme` | boolean | Also publish the theme **live** |
| `confirm_migrations_ran` | string | Must type exactly `I ran required migrations` |

**Behavior:**
1. Fails immediately if `confirm_migrations_ran` ≠ `I ran required migrations`.
2. If `deploy_worker`: `cd worker && npx wrangler deploy`.
3. If `deploy_theme`: `shopify theme push --unpublished`.
4. If `publish_theme`: `shopify theme push --live` (requires `deploy_theme` too).

**Never runs automatically on push/merge.**

**Environment:** `production` (requires manual approval if protection rules are set).

**Secrets required:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SHOPIFY_CLI_THEME_TOKEN`, `SHOPIFY_STORE`.

---

## Required GitHub configuration

### Environments

Create these in **GitHub → Settings → Environments**:

| Environment | Purpose | Protection rules |
|---|---|---|
| `preview` | Theme preview pushes | None required |
| `production` | Production deploy | **Required reviewers** (add yourself) |

### Secrets

Add in **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Used by | Example |
|---|---|---|
| `SHOPIFY_CLI_THEME_TOKEN` | preview + production | `shptka_…` (from Shopify Theme Access app) |
| `SHOPIFY_STORE` | preview + production | `r013gt-fc.myshopify.com` (canonical domain — `edenmish.myshopify.com` is an alias that the Theme Access proxy rejects with 401) |
| `CLOUDFLARE_API_TOKEN` | production only | Cloudflare API token with Workers edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | production only | `2dd658a7839937523c0cca09eadce085` |

> Do not put real values in workflow files or docs. These are GitHub repository secrets only.

---

## Production deployment sequence

```
1. Merge PR(s) into main
2. Run D1 migrations manually (see worker/MIGRATIONS.md):
     wrangler d1 execute edenmish --file=./migrations/003_rate_limits.sql
     wrangler d1 execute edenmish --file=./migrations/004_delivery_proofs.sql
     wrangler d1 execute edenmish --file=./migrations/005_notifications.sql
3. Go to GitHub → Actions → "Production deploy" → Run workflow
     - confirm_migrations_ran = "I ran required migrations"
     - deploy_worker = true
     - deploy_theme = true
     - publish_theme = false (preview first)
4. Test the unpublished theme preview
5. Re-run with publish_theme = true when ready
6. Smoke test the full order flow
```

---

## Rollback

| System | Rollback method |
|---|---|
| Cloudflare Worker | Cloudflare dashboard → Workers → previous deployment version (or re-run the workflow from an older `main` commit) |
| Shopify theme | Re-publish the previous theme version from the Shopify admin theme library |
| D1 migrations | Not automatically reversible — always test on a dev DB first. New tables are additive and can be safely ignored if rolled back. |

---

## Safety rules

- **No auto live-deploy on merge.** Production deploy is `workflow_dispatch` only.
- **No D1 migrations run automatically.** They are always manual + confirmed.
- **Production environment requires approval** (GitHub environment protection rule).
- **Theme live publish defaults to `false`** — you must explicitly opt in.
- **No secrets in workflow files.** All credentials are GitHub repository secrets.
