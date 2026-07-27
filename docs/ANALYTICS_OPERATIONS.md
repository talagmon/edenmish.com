# Consent-gated analytics operations

Operational runbook for issues
[#214](https://github.com/talagmon/edenmish.com/issues/214),
[#215](https://github.com/talagmon/edenmish.com/issues/215), and
[#219](https://github.com/talagmon/edenmish.com/issues/219).

## Current safety state

The storefront fetches the public `GTM_CONTAINER_ID` and explicit provider flags
from `/analytics-config`. When the ID is empty/invalid, or both provider flags are
disabled:

- no initial consent prompt is shown (the privacy-preferences control remains
  available and explains that measurement is disabled);
- no GTM, GA4, or Meta script is loaded;
- `window.edenAnalytics.track()` returns without emitting an event.

`ANALYTICS_GOOGLE_ENABLED` and `ANALYTICS_META_ENABLED` fail closed unless their
value is exactly `true` or `1` and the GTM ID is valid. Consent is provider-specific
and defaults to unknown/denied; an old broad grant is never migrated. The dialog
names only providers actually enabled. Refusal must not affect booking, payment,
tracking, cancellation, or WhatsApp links.

`ANALYTICS_CONVERSION_ORIGIN` must exactly match the HTTPS origin used for both
booking and Shopify's clean payment return. The current production return is
`https://edenmish.com`. Claims are disabled on staging, preview, `www`, or any
other origin unless Shopify is deliberately configured to return to that same
origin. This keeps the random credential in origin-scoped `sessionStorage`; it
must never be copied into a checkout URL, query string, or parent-domain cookie.

Production activation remains blocked until the controlled browser/network matrix
below passes. Keep Meta disabled until its separate owner/account decision is
recorded.

## Business-event data contract

The public `window.edenAnalytics.track()` API accepts only these business events:

| Browser event | GTM event | Intended measurement |
|---|---|---|
| `booking_started` | `eden_booking_started` | Booking page reached after consent |
| `booking_submitted` | `eden_booking_submitted` | Valid booking request submitted |
| `payment_started` | `eden_payment_started` | Hosted payment URL opened |
| `paid_order` | `eden_paid_order` | Verified ordinary Shopify payment observed once |
| `tracking_opened` | `eden_tracking_opened` | Tracking page successfully opened |
| `whatsapp_clicked` | `eden_whatsapp_clicked` | Public WhatsApp CTA clicked |
| `cancellation_submitted` | `eden_cancellation_submitted` | Cancellation request submitted |

Business-event parameters are limited to validated `service`, `size`, `review`,
`currency`, `value`, and a static-page `source`, plus the first-party pathname.
The paid event contains only `currency`, `value`, and the coarse pathname. Do not add names, email
addresses, phone numbers, addresses, coordinates, order numbers, tracking tokens,
free text, or stable customer identifiers.

The consent/container lifecycle also writes non-business control entries directly
to `dataLayer`: Google consent commands, the `gtm.js` bootstrap event, and
`eden_consent_updated` with `eden_consent`. These do not pass through
`safeParams()` and must be reviewed separately. They must never acquire customer,
order, full-location, referrer, query, or free-text fields.

The paid event is never inferred from the booking response, checkout redirect,
thank-you URL, or tracking page. With consent already active at order submission,
the browser creates a random 128-bit credential in `sessionStorage`; D1 stores only
its SHA-256 hash. The verified Shopify paid transition makes the claim redeemable.
The clean thank-you page may observe it once and receives only `paid_order`, `ILS`,
and the amount. Unknown/denied consent, missing provider configuration, withdrawal,
expiry, mismatch, refund-pending/refunded state, manual payment, wallet payment,
test mode, redelivery payment, and replay produce no event.

The D1 claim makes one browser the atomic winner, so refreshes and competing tabs
cannot emit twice. End-to-end delivery to a third-party analytics provider is
intentionally **at most once**, not mathematically exactly once: a browser can close
after D1 consumption but before its network dispatch. Solving that would require a
provider-visible stable idempotency identifier, which this privacy contract forbids.
Paid conversions already emitted remain historical capture facts; #219 does not
invent a negative/refund browser event.

## GA4/GTM activation

1. Merge and deploy #219 only after migration 032 is applied to the target D1.
2. The account owner creates/selects the EdenMish GA4 property, web stream, and
   production GTM web container without publishing it.
3. Set `ANALYTICS_GOOGLE_ENABLED=true` only in the controlled target environment.
   Keep `ANALYTICS_META_ENABLED` unset unless Meta has separately been approved.
4. In GTM, configure GA4 using the existing consent state. Do not add a second
   hardcoded consent banner or load tags outside the first-party boundary.
5. Map only the `eden_*` events above. Require the matching provider-consent field
   on every tag trigger.
6. Set GA4 `send_page_view=false`; disable Enhanced Measurement and all automatic
   events. Do not use GTM Page URL or Referrer variables. Send only the approved
   pathname field and explicitly blank `page_referrer`. For Meta, disable automatic
   events and advanced matching.
7. Set the public Cloudflare Pages production variables `GTM_CONTAINER_ID` and
   `ANALYTICS_CONVERSION_ORIGIN=https://edenmish.com`. Keep the conversion origin
   unset on staging/preview unless Shopify's return is configured to that exact
   origin; a separate test GTM container is still required for staging.
8. Publish the container only after the test matrix below passes.

Meta remains disabled until an authorized Business Portfolio and Pixel/Dataset
exist. If resumed, load it through the same consent-gated container. Keep advanced
matching disabled unless a new legal/privacy review explicitly approves it.

## Verification matrix

Run in a clean browser profile with network logging:

| Case | Expected result |
|---|---|
| Configuration empty | `/analytics-config` returns an empty ID; no banner or third-party analytics requests |
| First visit, no choice | Consent dialog visible; no GTM/GA4/Meta request |
| Essential-only choice | Choice persists; service works; no analytics request |
| Measurement accepted | GTM loads once; consent state updates; allowlisted events may emit |
| Preference revoked | Consent becomes denied immediately, provider cookies/storage are removed, all tabs stop, and the same URL reloads to terminate loaded vendor code |
| Business-event payload inspection | Every `eden_*` business event uses only its allowlisted keys and non-PII values |
| Control-event payload inspection | Consent commands, `gtm.js`, and `eden_consent_updated` contain only reviewed lifecycle fields and no customer/page data |
| Sensitive URL inspection | No tracking/business-login token, query string, fragment, full page location, or sensitive referrer is transmitted |
| Checkout-return origin | Paid-conversion claims are created only when `/analytics-config` reports the current origin as the configured Shopify return origin |
| Paid conversion authority | Redirect/return alone emits nothing; only verified Shopify settlement can make a consented claim emit |
| Paid conversion replay | Refresh, webhook replay, and concurrent tabs produce at most one browser event |
| Paid conversion exclusions | Manual/test/wallet/redelivery/mismatch/refund paths produce no paid event |
| Provider-specific copy | The consent dialog and privacy notice name only the providers/purposes actually enabled |
| Staging | No production container or dataset receives staging traffic |

Use GA4 DebugView/Realtime and the browser network panel with controlled test data.
Record the environment, event name, consent state, and pass/fail result. Do not
attach analytics payloads containing customer data.

## Withdrawal and retention

Every analytics-enabled customer page exposes a keyboard-accessible privacy
preferences button, including when providers are disabled. Withdrawal updates the
in-memory gate before asynchronous work, broadcasts through the versioned
`localStorage` choice, clears the pending session conversion, deletes the reviewed
Google/Meta first-party cookie and storage prefixes, removes the injected script,
and reloads the same URL if vendor code had executed. The reload is required
because removing a script element alone cannot unload JavaScript already running.

Claims expire after seven days. The daily Worker cleanup deletes expired claims and
observed claims after at most 30 days. The table contains no customer/contact,
address, tracking-token, Shopify, or analytics-provider identifier. Core
order/payment retention is unchanged.

## Disable and recover

To stop measurement without a code deployment, unset both provider flags (and
preferably `GTM_CONTAINER_ID`) in the production Pages environment and redeploy the
same storefront build. Then verify that `/analytics-config` returns both providers
as false and a clean browser loads no analytics scripts.
