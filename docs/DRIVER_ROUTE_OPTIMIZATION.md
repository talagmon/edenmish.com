# Driver route optimization

The Worker remains the authority for Eden's mixed pickup/drop-off queue. Waze
receives only the current locked stop; it does not decide the queue order.

## Re-optimization rule

When the driver is already navigating or has arrived, the current stop is a
fixed prefix and is never sent to the solver for reordering. The solver starts
at that stop and optimizes the remaining tasks:

- an uncollected order is one shipment with a pickup and a delivery;
- an onboard order is a delivery-only shipment;
- a locked pickup makes its paired delivery eligible as delivery-only;
- every returned route is validated locally for exact task membership and
  pickup-before-delivery precedence before it can become a route revision.

Only stable order/stop identifiers, coordinates, service durations, and time
windows are sent to Google. Customer names, phone numbers, and written addresses
are not part of the provider contract.

## Provider configuration

The provider is fail-closed and disabled unless all three values are available
to the Worker:

| Binding | Storage | Purpose |
|---|---|---|
| `ROUTE_OPTIMIZATION_PROVIDER=google` | Worker var | Explicit feature switch |
| `GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID` | Worker var | Google Cloud project with Route Optimization enabled |
| `GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON` | Worker secret | Dedicated service-account credential used to mint short-lived OAuth tokens |

The service account must be dedicated to one environment and have
`roles/routeoptimization.editor` plus `roles/serviceusage.serviceUsageConsumer`.
The Worker signs a short-lived OAuth assertion, caches the returned access token,
and sends it only in the authorization header. Set a low Google Cloud quota. Do
not put the service-account JSON in Flutter, repository files, URLs, or logs.

Authenticated Ops controls the single-driver shift. While a shift is active,
each driver route poll reconciles paid and in-progress orders into deterministic
pickup/drop-off tasks. A stable routing-input fingerprint prevents unchanged
polls from calling the billable provider. A new immutable revision is optimized
and persisted only when task membership, coordinates, priority, time windows, or
execution state changes. The app's existing polling then receives the new
revision without a manual refresh.

When the Google provider is fully configured, the Worker uses it and validates
the returned membership and pickup precedence before persisting the revision.
When it is disabled or unavailable, a deterministic nearest-neighbour fallback
keeps the locked current stop first and preserves pickup-before-delivery. This
fallback makes dispatch operational without exposing customer PII or requiring
Google billing for the one-driver pilot.
