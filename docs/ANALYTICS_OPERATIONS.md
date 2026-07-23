# Consent-gated analytics operations

Operational runbook for issues
[#214](https://github.com/talagmon/edenmish.com/issues/214) and
[#215](https://github.com/talagmon/edenmish.com/issues/215).

## Current safety state

The storefront fetches the public `GTM_CONTAINER_ID` from `/analytics-config`.
When it is empty or invalid:

- no consent banner is shown;
- no GTM, GA4, or Meta script is loaded;
- `window.edenAnalytics.track()` returns without emitting an event.

When configured, Google consent defaults to denied. The container loads only after
the visitor explicitly grants measurement consent. Refusal must not affect booking,
payment, tracking, cancellation, or WhatsApp links.

## Data contract

The first-party event layer accepts only these events:

| Browser event | GTM event | Intended measurement |
|---|---|---|
| `booking_started` | `eden_booking_started` | Booking page reached after consent |
| `booking_submitted` | `eden_booking_submitted` | Valid booking request submitted |
| `payment_started` | `eden_payment_started` | Hosted payment URL opened |
| `tracking_opened` | `eden_tracking_opened` | Tracking page successfully opened |
| `whatsapp_clicked` | `eden_whatsapp_clicked` | Public WhatsApp CTA clicked |
| `cancellation_submitted` | `eden_cancellation_submitted` | Cancellation request submitted |

Allowed parameters are limited to `service`, `size`, `review`, `currency`, `value`,
and `source`, plus the first-party page path. Do not add names, email addresses,
phone numbers, addresses, coordinates, order numbers, tracking tokens, free text,
or stable customer identifiers.

Issue #6 also asks for paid-order measurement. There is currently no authoritative
`paid_order` browser event: the booking success page is not proof that Shopify
payment settled. Add that conversion only in a separate runtime change driven by
the verified paid webhook/server state; do not infer it from a redirect or URL
parameter.

## GA4/GTM activation

1. The account owner creates/selects the EdenMish GA4 property, web stream, and
   production GTM web container.
2. In GTM, configure GA4 using the existing consent state. Do not add a second
   hardcoded consent banner or load tags outside the first-party boundary.
3. Map only the `eden_*` events above. Mark conversions only after their business
   definitions are reviewed.
4. Set the public Cloudflare Pages production variable `GTM_CONTAINER_ID`.
   Keep staging empty or use a separate test container.
5. Publish the container only after the test matrix below passes.

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
| Preference revoked | Subsequent events stop; consent update is visible to the loaded container |
| Event payload inspection | Only allowlisted keys and non-PII values are present |
| Staging | No production container or dataset receives staging traffic |

Use GA4 DebugView/Realtime and the browser network panel with controlled test data.
Record the environment, event name, consent state, and pass/fail result. Do not
attach analytics payloads containing customer data.

## Disable and recover

To stop measurement without a code deployment, unset `GTM_CONTAINER_ID` in the
production Pages environment and redeploy the same storefront build. Then verify
that `/analytics-config` returns an empty ID and a clean browser loads no analytics
scripts.
