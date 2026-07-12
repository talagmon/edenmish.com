# Environment & Secrets

> **This repository is PUBLIC.** Never commit real secret values — not in code,
> not in `wrangler.toml`, not in theme files, not in comments, not in history.
> All real values live in Cloudflare Worker **secrets**, local gitignored `.env*`
> files, or Shopify admin settings.

This file lists **placeholder names only**. Copy the pattern, never the value.

---

## Where each kind of value lives

| Value type | Where it lives | Example |
|---|---|---|
| Worker **secret** | `wrangler secret put <NAME>` (Cloudflare dashboard) | `OPS_PIN`, `SHOPIFY_ADMIN_TOKEN` |
| Worker **non-secret var** | `worker/wrangler.toml [vars]` | `BRAND`, `SHOPIFY_SHOP` |
| Shopify theme **setting** | Shopify admin → Themes → Customize | `google_maps_key`, `whatsapp_number` |
| Local dev **env** | `.env*` (gitignored) | Shopify CLI token |

---

## Worker secrets (`wrangler secret put …`)

These are **not** in `wrangler.toml`. Optional integrations no-op if unset, but
authentication and OTP flows fail closed when `SESSION_SECRET` is missing.

| Secret | Purpose | Placeholder example |
|---|---|---|
| `OPS_PIN` | Ops dashboard login PIN | `replace-me-strong-pin` |
| `SESSION_SECRET` | Signs the ops session cookie + hashes OTPs | `replace-me-long-random-string` |
| `MAPS_KEY` | Google Maps JS key, injected into the tracking page HTML | `AIza…` (set as a secret; do **not** put in `wrangler.toml`) |
| `SHOPIFY_ADMIN_TOKEN` | Creates Shopify Draft Orders (custom app token) | `shpat_replaceme` |
| `SHOPIFY_WEBHOOK_SECRET` | Verifies the `orders/paid` webhook HMAC | `replace-me-from-shopify-webhook-page` |
| `SENDGRID_API_KEY` | All outbound email (customer OTP/confirmation + Eden alerts) | `SG.replaceme` |
| `MESH_API_KEY` | **Future** — Mesh/J5 preauth processor. Not used today. | (unset for now) |

> `SESSION_SECRET` is mandatory. The Worker refuses to create sessions or OTP hashes
> when it is unset; set it before accepting orders or enabling the ops dashboard.

## Worker non-secret vars (`worker/wrangler.toml [vars]`)

These are safe to keep in the repo (non-secret configuration):

| Var | Purpose |
|---|---|
| `BRAND` | Brand name shown in UI |
| `BOOKING_URL` | Where `find.edenmish.com/` root redirects (the Shopify site) |
| `WHATSAPP_NUMBER` | Eden's WhatsApp number (international format, no `+`) |
| `OPS_EMAIL` | Eden's ops alert address |
| `SHOPIFY_SHOP` | Shopify shop domain, e.g. `edenmish.myshopify.com` |
| `SHOPIFY_API_VERSION` | Shopify Admin API version, e.g. `2026-04`. **Set this explicitly in production** — the code's hardcoded fallback (`2026-04` in `worker/src/integrations.js`) will eventually be deprecated by Shopify, and bumping a var beats redeploying code |
| `ALLOWED_ORIGINS` | **Required in production.** Comma-separated CORS allowlist. Include every storefront/ops page origin that calls the Worker. Credentialed ops-cookie requests require an explicit origin and cannot use the `*` fallback. Local dev may add `http://127.0.0.1:PORT`. |

> Optional future var: `PAYMENT_MODE` (`immediate` today, `preauth` for Mesh later).

## Staging Worker isolation

The staging storefront never calls the production Worker. Shared routing in
`storefront/public/assets/api-origin.js` maps staging and Cloudflare Pages preview
hosts to `find-staging.edenmish.com` / `ops-staging.edenmish.com`.

The GitHub `staging` environment contains only:

| Name | Type | Purpose |
|---|---|---|
| `STAGING_D1_DATABASE_ID` | environment variable | Binds the separate `edenmish-staging` D1 database |
| `STAGING_OPS_PIN` | environment secret | Staging-only dashboard PIN |
| `STAGING_SESSION_SECRET` | environment secret | Staging-only cookie/OTP signing key |

Never copy production Shopify, payment, webhook, email, or customer-data
credentials into the staging Worker. See `CI_CD.md` for one-time setup.

---

## Cloudflare Pages secrets (canonical storefront)

| Secret | Purpose | Required Google services |
|---|---|---|
| `MAPS_KEY` | Returned by the server-side `/maps-key` function for booking address autocomplete and customer maps | Maps JavaScript API and **Places API (New)** |

The canonical booking page uses `PlaceAutocompleteElement`, `gmp-select`, and
`Place.fetchFields()`. Enable Places API (New) in the same Google Cloud project
before releasing the migration, and restrict the browser key to the EdenMish
production, staging, and approved preview origins. If the new Places library
cannot initialize, the form keeps both plain address inputs visible; no key or
configuration value is embedded in git.

Google references: [Autocomplete migration guide](https://developers.google.com/maps/documentation/javascript/legacy/places-migration-autocomplete)
and [Place Autocomplete Widget](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new).

---

## Shopify theme settings (admin → Themes → Customize → "EdenMish Funnel")

These live in the Shopify admin (stored in `templates/index.json` settings), **not**
in code:

| Setting | Purpose | Notes |
|---|---|---|
| `whatsapp_number` | WhatsApp CTA + fallback number | international format |
| `google_maps_key` | Google Maps JS key for address autocomplete + estimate on the funnel | keep out of code; setting has **no default** (graceful fallback to plain address field if empty) |
| `storefront_token` | Storefront API token for cart prefill (legacy cart path) | will be removed when the cart path is retired |
| `price_base` / `price_per_km` | Client-side price estimate inputs | server pricing uses `pricing_rules` in D1 |

> The Google Maps key must also be set as the Worker secret `MAPS_KEY` for the
> tracking page. Two places, same key, both out of git.

---

## Shopify CLI / local dev (gitignored)

| Var | Purpose | Placeholder |
|---|---|---|
| `SHOPIFY_CLI_THEME_TOKEN` | Non-interactive `shopify theme …` commands | `shptka_replaceme` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API scripts (read/write products, orders) | `shpat_replaceme` |

These go in local `.env*` files, **never** committed.

---

## Gitignore guarantees (already in place)

The following are ignored and must stay ignored:

- `.env`, `.env.local`, `.env.*.local`, `.env.*` (except `.env.example`)
- `node_modules/`
- `.shopify/`
- `.wrangler/` (Wrangler local cache)
- `.playwright-mcp/` (browser session snapshots — may contain typed secrets)
- Build outputs: `dist/`, `build/`, `.cache/`, `.vite/`
- OS/editor: `.DS_Store`, `.vscode/`, `.idea/`

See `../.gitignore`. If you find a real key in any tracked file, **stop and flag
it** (per `../AGENTS.md` §2), then move it to a secret/setting.

---

## Public vs secret — quick reference

| Public (OK in repo) | Secret (NEVER in repo) |
|---|---|
| `SHOPIFY_SHOP`, `SHOPIFY_API_VERSION`, `SHOPIFY_APP_CLIENT_ID` | `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_CLI_THEME_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` |
| `BRAND`, `BOOKING_URL`, `WHATSAPP_NUMBER`, `OPS_EMAIL` | `OPS_PIN`, `SESSION_SECRET` |
| brand colors, Hebrew copy | `MAPS_KEY` (Worker + theme), `SENDGRID_API_KEY`, `MESH_API_KEY` |

> The public business phone numbers and `eden@edenmish.com` are intentionally
> public contact info, **not** secrets.
