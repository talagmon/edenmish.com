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
- Version metadata: validates the repo-root `VERSION` file is `X.Y.Z`, that
  `scripts/compute_build_number.sh` returns an integer, and that
  `scripts/bump_version.sh --dry-run` runs without error.

**Secrets required:** none. CI runs without any credentials.

---

### `storefront.yml` — Storefront build + deploy

**Trigger:** `push` or `pull_request` to `main`, only when `storefront/**` changes.

**Behavior:**
- Computes version metadata (`APP_VERSION` from `VERSION`, `BUILD_NUMBER` from
  `scripts/compute_build_number.sh`, `GIT_SHA` from `git rev-parse --short HEAD`)
  and exposes it as env vars for the build.
- `npm run build` runs Tailwind, then `storefront/scripts/inject-version.js`
  bakes `<meta name="app-version">` + a footer stamp into every `public/*.html`.
- On `push` to `main`: deploys `public/` to Cloudflare Pages (`edenmish-v2` project).

**Secrets required:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

---

### `shopify-preview.yml` — Shopify theme preview

**Trigger:** `pull_request` to `main`, only when `theme/**` files change.

**Behavior:**
- Injects version metadata into `theme/snippets/app-version.liquid` so the
  preview shows the same stamp production will.
- Pushes an **unpublished** theme to the Shopify store using `shopify theme push --unpublished`.
- Extracts the preview URL from the JSON output.
- Comments the preview URL on the PR (updates if re-run).
- Prints the URL in the GitHub Actions summary.

**Never publishes live.**

**Secrets required:** `SHOPIFY_CLI_THEME_TOKEN`, `SHOPIFY_STORE`.

**Environment:** `preview`.

---

### `release.yml` — auto-tag from conventional commits

**Trigger:** `push` to `main` (typically a merged PR).

**Behavior:**
- Runs `scripts/bump_version.sh --tag` — reads Conventional Commit messages
  since the last `v*` tag and creates a new tag:
  - `BREAKING CHANGE:` / `<type>!:` → major
  - `feat:` → minor
  - `fix:`, `perf:`, `refactor:`, … → patch
  - `chore:`, `test:`, `docs:` only → no bump (exits 0)
- If a new tag was created: pushes only the tag to origin.
  **Never commits to main** — main's history stays 100% human-authored.
- If no bump: no-op.

**This workflow does NOT deploy.** Production deploy stays manual per §8 of
`AGENTS.md`. The bump only advances the version *name*; the build *number* is
always recomputed at deploy time.

**Why tags, not a VERSION file:** tags are not subject to branch protection,
so this workflow needs only `contents: write` for tag pushes (never for
branch pushes). It works regardless of main's protection rules, and there's
no self-trigger loop to guard against.

**Permissions:** `contents: write` (to push the `vX.Y.Z` tag).

**Secrets required:** none beyond the default `GITHUB_TOKEN`.

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
2. Computes version metadata (latest `v*` tag via `current_version.sh` +
   `compute_build_number.sh` + git SHA).
3. Injects the version into the Worker (`worker/src/version.js`) and theme
   (`theme/snippets/app-version.liquid`) before any deploy runs. The injected
   values are not committed — they live only in the CI runner's checkout.
4. If `deploy_worker`: `cd worker && npx wrangler deploy`.
5. If `deploy_theme`: `shopify theme push --unpublished`.
6. If `publish_theme`: `shopify theme push --live` (requires `deploy_theme` too).

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

## Version metadata

Every deployed surface reports a build stamp of the form
`vX.Y.Z #BUILD_NUMBER (GIT_SHA)` — e.g. `v0.2.0 #270421 (77fe86e)`.

- **`X.Y.Z`** — the release name. Source of truth is the **latest `v*` git tag**
  (read by `scripts/current_version.sh`). Tags are created automatically by
  `release.yml` from Conventional Commits; never blocked by branch protection.
- **`BUILD_NUMBER`** — minutes since `2026-01-01 00:00:00 UTC`, computed by
  `scripts/compute_build_number.sh`. Monotonic across branches/runners.
  Override with the `BUILD_NUMBER` env var (CI / hotfix).
- **`GIT_SHA`** — `git rev-parse --short HEAD` at build time.

> **Why tags, not a VERSION file:** a VERSION file requires the release bot
> to commit back to main, which collides with branch protection rules.
> Tags live outside branch protection, so the bot needs only `contents: write`
> for tag pushes — never for branch pushes. Main's history stays 100%
> human-authored.

### Where the stamp shows up

| Surface | Where | How it's injected |
|---|---|---|
| Worker — customer tracking page (`find.edenmish.com/t/:token`) | Footer line below the timeline | `worker/src/version.js` (rewritten by `scripts/inject-worker-version.sh` before `wrangler deploy`) |
| Worker — ops dashboard (`ops.edenmish.com`) | Toolbar, next to the bike icon | Same |
| Storefront (`edenmish.com`, all HTML pages) | `<meta name="app-version">` in `<head>` + footer stamp on customer pages | `storefront/scripts/inject-version.js` runs as part of `npm run build` |
| Shopify theme (`edenmish.com` Shopify-served pages) | Footer via `{% render 'app-version' %}` in `theme/layout/theme.liquid` | `theme/snippets/app-version.liquid` (rewritten by `scripts/inject-theme-version.sh` before `shopify theme push`) |

### Local dev

The committed files ship `0.0.0-dev` defaults so `wrangler dev`, the theme
preview, and `npm run build` all work without any version generation. CI
overwrites the values at deploy time only.

### Local build side effect

`cd storefront && npm run build` mutates `public/*.html` in place with the
current version stamp. To discard the local changes after a build:

```bash
git checkout -- storefront/public/
```

### Manual bump (hotfix / pre-release)

To cut a release manually instead of waiting for `release.yml`:

```bash
./scripts/bump_version.sh --tag
git push origin "v$(./scripts/current_version.sh)"
```

(`current_version.sh` will then return the new tag on the next run.)

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
