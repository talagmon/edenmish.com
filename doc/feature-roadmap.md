# EdenMish — Feature & Operations Roadmap

> Working doc for the delivery-ops layer on top of the Shopify site.
> Status: planning. Items marked **[buildable now]** I can implement directly; others need accounts/keys.

---

## 1. Address autocomplete (from → to with street recognition)
**Goal:** customer types pickup/drop-off → get Israeli street suggestions → accurate addresses (and enables distance pricing).

- **Recommendation: Google Places Autocomplete** (Places API + Address Validation).
  - Best Hebrew + Latin coverage for Israel, the industry standard.
  - Cost: ~$2.83 / 1,000 lookups (with session tokens) — negligible for low volume.
  - **[buildable now]** — I wire it into the two address fields in the funnel form. You create a Google Cloud project, enable *Places API*, give me the key.
  - Same key unlocks **distance-based pricing** (research R7): compute pickup→drop-off distance and show an indicative price before WhatsApp.
- Alternatives: Mapbox (cheaper), Apple MapKit JS (free tier), Here.

## 2. Order-status link + live tracking
**Goal:** customer gets a link with: Order received → Driver assigned → On the way → Delivered, **plus live GPS map** of the driver.

- **DECISION: Plan A — custom build on Cloudflare Workers + D1** (full design: `doc/tracking-system-design.md`). Branded, no per-task fees; live GPS via the driver's mobile page.
  - Customer tracking page → **`ops.edenmish.com`** (`/t/:token`): status timeline + live map + completion summary.
  - Driver/ops page → **`ops.edenmish.com/driver`**: queue, status updates, GPS broadcast, complete+summary. PIN-protected.
  - Booking/marketing stays on `edenmish.com` (Shopify funnel).
- **Fallback (if live-GPS reliability / multi-driver routing demands it): Onfleet** — native driver app (background GPS), built-in routing, automatic notifications + POD, per-task pricing.
- Other alternatives considered: Track-POD, EasyRoutes (Shopify-native).

## 3. Smart delivery management (route optimization, speed)
**Goal:** plan the fastest sequence of pickups/drop-offs, dispatch to driver, optimize as volume grows.

- **Recommendation: Onfleet** — covers Q2 + Q3 together: route optimization, driver app, live tracking, notifications, POD. Best fit for a courier that will grow beyond one driver.
- Pure-routing alternatives if you only need optimization: **Routific** (best routing), **Tookan**, **FarEye**.
- For a solo courier today: Onfleet's starter tier (or a simpler tool) is enough; add dedicated routing only when multi-stop days get complex.

## 4. What we missed / still need (prioritized)

### Critical / legal
- **Email hosting for `eden@edenmish.com`** — the address is on the site but needs a real mailbox (Google Workspace / Microsoft 365 / Zoho) + MX DNS records, or emails to it will bounce.
- **Terms of Service + Refund/Cancellation policy** — required for a service (lost/damaged package liability, cancellation cutoff, refunds). Israeli consumer law.
- **Privacy policy page** — publish at `Settings → Policies` (text is ready in `doc/policies/`).
- **PayPlus (payment provider)** — still pending; checkout can't take money yet.
- **Invoicing / receipts** — as עוסק פטור, issue a receipt or transaction invoice and receipt (קבלה / חשבונית עסקה וקבלה), as applicable. PayPlus or an invoicing app can provide this.

### Operational
- **WhatsApp Business** (not personal) for the booking number → away message, quick replies, labels; later **WhatsApp Cloud API** for automated tracking messages.
- **Shopify Flow** (free) → notify Eden instantly on every new paid order (email/WhatsApp webhook).
- **Proof of delivery** (photo/signature) — via Onfleet/Track-POD.

### Marketing / quality
- **Analytics**: Google Analytics 4 + Meta Pixel + Google Search Console (verify domain, submit sitemap) for conversion tracking.
- **SEO**: Hebrew meta titles/descriptions, `LocalBusiness` schema.
- **Cookie / privacy banner** (Israeli privacy law).
- **Mobile + RTL QA**, image optimization.
- **Backup / version control** — repo is in place (good).

---

## Suggested next builds (in order)
1. **Google Places address autocomplete** in the funnel form [+ distance-based indicative price] — needs your API key. **[buildable now]**
2. **Onfleet setup** for tracking + driver app + routing (covers Q2 + Q3).
3. **Terms + Refund/Cancellation policy** drafted + published.
4. **Email hosting** for eden@edenmish.com.
5. **PayPlus** connection → enable online payment.
6. **Analytics + Search Console**.
