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
| `SESSION_SECRET` | Signs/hashes ops, driver and business sessions, magic links, OTPs, and rate-limit identifiers | `replace-me-long-random-string` |
| `DRIVER_ONE_TIME_CODE` | Single-use bootstrap code exchanged by the driver app; rotate after each successful exchange | `replace-with-6-to-12-digits` |
| `MAPS_KEY` | Google Maps JS key, injected into the tracking page HTML | `AIza…` (set as a secret; do **not** put in `wrangler.toml`) |
| `GOOGLE_PLACES_SERVER_KEY` | Server-only Places API (New) key for authenticated business batch address validation | `AIza…` (restrict to Places API (New); never expose to browsers) |
| `SHOPIFY_ADMIN_TOKEN` | Creates Shopify Draft Orders (custom app token) | `shpat_replaceme` |
| `SHOPIFY_WEBHOOK_SECRET` | Verifies `orders/paid`, `orders/updated`, and `refunds/create` webhook HMACs | `replace-me-from-shopify-webhook-page` |
| `SENDGRID_API_KEY` | All outbound email (customer OTP/confirmation + Eden alerts) | `SG.replaceme` |
| `WHATSAPP_PHONE_ID` | Optional WhatsApp Cloud API phone-number ID; keep unset until the account/template review and controlled test are ready | `replace-with-provider-phone-id` |
| `WHATSAPP_TOKEN` | Optional least-privilege WhatsApp Cloud API token; rotate and revoke through the authorized Meta Business account | `replace-with-provider-token` |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on delivery-receipt webhooks | `replace-with-meta-app-secret` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Private challenge token for registering `/webhooks/whatsapp` | `replace-with-random-verify-token` |
| `WHATSAPP_OPS_RECIPIENT` | Separate verified internal operations recipient; never reuse `WHATSAPP_NUMBER` | `replace-with-operations-number` |
| `WHATSAPP_OPS_PAYMENT_TEMPLATE` | Approved zero-component internal paid-order template name | `eden_ops_payment_received` |
| `WHATSAPP_OPS_TEMPLATE_LANGUAGE` | Explicit language code for the internal template | `he` |
| `WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE` | Approved zero-component customer delivery template name | `eden_delivery_complete` |
| `WHATSAPP_CUSTOMER_TEMPLATE_LANGUAGE` | Explicit language code for the customer template | `he` |
| `GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON` | Server-side driver route optimization; use a dedicated environment-specific service account and never ship it to Flutter | `{"type":"service_account",…}` |
| `APNS_TEAM_ID` | Apple Developer Team ID used to sign APNs provider tokens for driver route notifications | `replace-with-10-character-team-id` |
| `APNS_KEY_ID` | ID of the APNs signing key created in Apple Developer Certificates, Identifiers & Profiles | `replace-with-10-character-key-id` |
| `APNS_PRIVATE_KEY_P8` | Raw contents of the APNs signing key; store only as an encrypted Worker secret | `-----BEGIN PRIVATE KEY-----…` |
| `MESH_API_KEY` | **Future** — Mesh/J5 preauth processor. Not used today. | (unset for now) |

> `SESSION_SECRET` is mandatory. The Worker refuses to create sessions or OTP hashes
> when it is unset; set it before accepting orders or enabling the ops dashboard.
>
> WhatsApp automation is optional and fail-safe. Shared credentials cannot
> activate either message class without that class's separate template/language
> configuration; operations also requires its distinct recipient. Follow
> `WHATSAPP_OPERATIONS.md` before adding any production value, and keep the
> values unset until issue #216 records the retained legal-approval and
> final-published-version activation evidence as complete.

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
| `ALLOWED_ORIGINS` | **Required in production.** Comma-separated CORS allowlist. Include every storefront/ops page origin that calls the Worker. Credentialed ops and business-account requests require an explicit origin and cannot use the `*` fallback. Local dev may add `http://127.0.0.1:PORT`. |
| `AUTO_DRIVER_DISPATCH` | Set to `on` to reconcile the active driver's immutable route revisions from the canonical paid/in-progress order queue on each route poll |
| `ROUTE_OPTIMIZATION_PROVIDER` | Optional explicit switch; set to `google` only after billing, quota, and credentials are approved |
| `GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID` | Google Cloud project ID/number with Route Optimization enabled; required only when the provider is `google` |
| `BUSINESS_BATCH_AI_MODEL` | Workers AI model used only when the deterministic business-batch template parser cannot recognize a file; the configured model must support JSON-schema output |
| `EMAIL_FROM_ADDRESS` | Verified SendGrid sender address. Production uses `no-reply@edenmish.com`; staging uses `no-reply-staging@edenmish.com` |
| `EMAIL_FROM_NAME` | Human-readable sender name shown by email clients |
| `EMAIL_SUBJECT_PREFIX` | Optional prefix added once to every outbound subject; staging uses `[STAGING]` |
| `EMAIL_RECIPIENT_POLICY` | `open` for production or `allowlist` for isolated environments. Unknown values fail closed |
| `EMAIL_RECIPIENT_ALLOWLIST` | Comma-separated exact recipient addresses allowed when the policy is `allowlist`; staging contains only its QA mailbox |
| `APNS_ALLOWED_TOPICS` | Comma-separated exact iOS bundle IDs accepted during device registration. Production allows `com.edenmish.edendriver` and `com.edenmish.edendriver.nativebeta`; staging allows native beta only |

> Optional future var: `PAYMENT_MODE` (`immediate` today, `preauth` for Mesh later).

## Workers AI binding

`worker/wrangler.toml` and `worker/wrangler.staging.toml` bind Workers AI as
`env.AI`. This is Cloudflare account configuration, not a secret, and requires
Workers AI to be available for the deployed account. The default
`BUSINESS_BATCH_AI_MODEL` is `@cf/meta/llama-3.1-8b-instruct-fast`.

The binding is invoked only as a fallback for an unfamiliar XLSX/CSV layout.
Recognized official templates bypass it. The Worker sends bounded cell content
for header mapping and row normalization, does not log or persist the uploaded
file, rejects malformed or low-confidence output, and requires customer approval
of AI-assisted interpretations before any orders can be created.

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
| `STAGING_DRIVER_ONE_TIME_CODE` | environment secret | Staging-only single-use driver bootstrap code |
| `STAGING_GOOGLE_PLACES_SERVER_KEY` | environment secret | Dedicated staging Places API (New) server key; never reuse production credentials |
| `STAGING_GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON` | environment secret | Staging-only Google service-account JSON; never reuse production credentials |
| `STAGING_SENDGRID_API_KEY` | environment secret | Dedicated custom-access SendGrid key with only Mail Send permission |
| `STAGING_APNS_TEAM_ID` | environment secret | Apple Developer Team ID for staging driver push |
| `STAGING_APNS_KEY_ID` | environment secret | APNs signing key ID for staging driver push |
| `STAGING_APNS_PRIVATE_KEY_P8` | environment secret | Raw APNs `.p8` key; the workflow injects it into the staging Worker only |

Staging email is intentionally limited to `qa-staging@edenmish.com`, uses the
`no-reply-staging@edenmish.com` sender and prefixes subjects with `[STAGING]`.
The Worker rejects every other staging recipient before calling SendGrid. Never
copy production Shopify, payment, webhook, email, or customer-data credentials
into the staging Worker. See `CI_CD.md` for one-time setup.

---

## Cloudflare Pages secrets and variables (canonical storefront)

| Secret | Purpose | Required Google services |
|---|---|---|
| `MAPS_KEY` | Returned by the server-side `/maps-key` function for booking address autocomplete, route distance, and customer maps | Maps JavaScript API, **Places API (New)**, and **Routes API** |

The analytics variables are public, non-secret Cloudflare Pages configuration.
Leave all four unset to disable analytics completely; staging should remain
disabled or use a separate reviewed test container. A valid container ID alone
does not activate a provider. The browser loads GTM only when at least one explicit
provider flag is enabled and the visitor grants that provider. GA4 and Meta
identifiers are configured in GTM and must not be embedded in the storefront
repository.

| Variable | Purpose |
|---|---|
| `GTM_CONTAINER_ID` | Google Tag Manager web-container ID (`GTM-…`) |
| `ANALYTICS_GOOGLE_ENABLED` | Exact `true` or `1` enables the Google Analytics consent choice; false/unset fails closed |
| `ANALYTICS_META_ENABLED` | Exact `true` or `1` enables the Meta Pixel consent choice; keep unset until its separate owner review is complete |
| `ANALYTICS_CONVERSION_ORIGIN` | Exact HTTPS storefront origin that Shopify returns to after payment (production: `https://edenmish.com`); unset or a different request origin disables paid-conversion claims |

Follow `ANALYTICS_OPERATIONS.md` for the event/data contract, account-owner steps,
consent verification matrix, and emergency disable procedure. Keep all analytics
variables unset until the controlled browser/network acceptance matrix is complete.

The canonical booking page uses `PlaceAutocompleteElement`, `gmp-select`, and
`Place.fetchFields()` for addresses, plus the Maps JavaScript Routes library's
`RouteMatrix.computeRouteMatrix()` for driving distance. The customer tracking
page uses the same Routes library's `Route.computeRoutes()` for its road overlay
and traffic-aware ETA. Enable Places API (New) and Routes API in the same Google
Cloud project before releasing these features, and add both services to the
browser key's API restrictions. Restrict that key to the EdenMish production,
staging, and approved preview origins. If address or route services are
unavailable, the pages retain their plain-address, bounded-quote, and
straight-line route fallbacks; no key or configuration value is embedded in git.

Do not remove legacy Places API or Distance Matrix API key permissions until the
remaining Shopify-theme consumers have been migrated and verified in their own
PR. Directions API is no longer required by repository code after the tracking
Route migration, but removing its key permission remains a separate operator
change after staging verification.

Google references: [Autocomplete migration guide](https://developers.google.com/maps/documentation/javascript/legacy/places-migration-autocomplete)
and [Place Autocomplete Widget](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new),
plus [Get started with Routes](https://developers.google.com/maps/documentation/javascript/routes/start)
and [Route Matrix](https://developers.google.com/maps/documentation/javascript/routes/get-a-route-matrix),
and [Route migration](https://developers.google.com/maps/documentation/javascript/routes/routes-js-migration).

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
| `BRAND`, `BOOKING_URL`, `WHATSAPP_NUMBER`, `OPS_EMAIL`, `APNS_ALLOWED_TOPICS` | `OPS_PIN`, `SESSION_SECRET`, `DRIVER_ONE_TIME_CODE`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_OPS_RECIPIENT`, both class-specific template/language pairs, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY_P8` |
| brand colors, Hebrew copy | `MAPS_KEY` (Worker + theme), `SENDGRID_API_KEY`, `GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON`, `MESH_API_KEY` |

> The public business phone numbers and `eden@edenmish.com` are intentionally
> public contact info, **not** secrets.
