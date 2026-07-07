# Changelog

All notable changes to the EdenMish storefront are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), adhering to
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-07-07

### Added
- Apex cutover: `edenmish.com` now serves the v2 storefront (replaces Shopify funnel)
- Branded checkout domain: `pay.edenmish.com` (PayPlus + Shopify)
- Delivery confirmation page (`delivered.html`) with PoD photo + signature + route map (Maps JS API) + star rating
- Rating endpoint: `POST /api/orders/:token/rate` (persists to D1 `orders.rating`)
- Flash immediate-delivery option (working-hours + zones 1–2 gated)
- Ops dashboard: KPI stats bar, priority sorting, urgent badges, service chips
- Statistics view with SVG charts (7-day volume, service donut, status breakdown)
- Status timeline on order detail (6-step progress tracker)
- Real-time inline email validation on the booking form
- Favicon (brand logo), Open Graph + Twitter meta tags on all pages
- Team credits (Six Elements Altiora + Tal Agmon) in footer + About page
- `pay.edenmish.com` branded checkout subdomain
- Storefront monorepo migration (`edenmish-v2` → `edenmish.com/storefront/`)
- Auto-deploy CI (Storefront workflow on push to main)
- Maps JS API for booking autocomplete + delivered route map
- Syntax checker (`npm run syntax-check`) — catches JS errors before deploy
- Version bump scripts (`npm run version:patch/minor/major`)

### Changed
- `STOREFRONT_BASE` moved from `v2.edenmish.com` → `edenmish.com` (canonical)
- Adopted v2 mint palette across all Worker emails (gold retired)
- Policy dates aligned (all `יוני 2026`)
- HSTS security header added (`max-age=31536000; includeSubDomains`)
- `ops.edenmish.com/` now redirects to the new storefront dashboard
- PoD signature column added to `getDeliveryOrder` SELECT

### Fixed
- Booking time-slot bug (auto-select first window)
- PoD signature not reaching delivered.html/track.html (missing in SELECT)
- Stale frontend (Pages project wasn't auto-deploying — CI workflow added)
- `?test=1` payment bypass removed from production (TEST_MODE secret deleted)
- Misleading test-mode banner removed from the booking form
- Shopify webhook self-registration (lazy check on cold start)
- Saturday orders rejected server-side (שומר שבת)
- PayPlus payment page re-connected after domain change

### Security
- `TEST_MODE` removed from production Worker secrets
- `.gitignore` updated for `.dev.vars`
- Stale `GITHUB_TOKEN` removed from shell profile
- All secrets remain in Cloudflare secrets (never committed)

## [0.1.0] - 2026-07-05

### Added
- Initial storefront: home, booking, track, about, success/error, legal pages
- Worker API: order creation, tracking, OTP, PoD, ops dashboard
- Cloudflare Pages deployment at `v2.edenmish.com`
- Tailwind design system (dark glassmorphism, Hebrew RTL)
