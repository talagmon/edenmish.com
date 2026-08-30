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

## Optimization objective

The production objective is shortest-total-path first, not FIFO and not the
order in which rows were imported. Google receives a five-second
`CONSUME_ALL_AVAILABLE_TIME` solve with road traffic enabled and these explicit
relative costs:

- `costPerKilometer = 1000` is the dominant route-distance cost;
- `costPerTraveledHour = 240` lets one hour of traffic saving justify at most
  240 additional metres;
- an urgent drop-off has a 90-minute soft target with a late cost of 100 per
  hour, so one hour of priority improvement can justify at most 100 additional
  metres.

All shipments remain mandatory. Priority can therefore move a package earlier
only for a bounded, reasonable detour; it can never remove a delivery. A shared
business batch is represented as one physical pickup followed by every drop-off,
with explicit cross-shipment precedence rules tying every sibling package to
that pickup. The solver then minimizes the complete trailing path and naturally
keeps nearby drops together before moving to the next closest area.

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
execution state changes. The fingerprint also includes a route-policy version,
so deploying a new optimization policy forces one fresh revision for an active
queue. The app's existing polling then receives the new revision without a
manual refresh.

When the Google provider is fully configured, the Worker uses it and validates
the returned membership and pickup precedence before persisting the revision.
When it is disabled or unavailable, a deterministic local fallback seeds the
route with nearest-neighbour order and then applies whole-route 2-opt
improvements. It keeps the locked current stop first, rejects every reversal
that would violate pickup-before-delivery precedence, and uses the same bounded
urgent-lateness tradeoff. The fallback has no live-traffic data, but avoids
greedy crossing and backtracking for the one-driver pilot without exposing
customer PII or requiring Google billing.

## Revision safety

The API compares every task execution event with the first unfinished stop in
the newest server route. A client may submit an older `route_revision_seen` only
when its stop is still that canonical current stop. If the stop changed, the
event is durably recorded as `accepted_conflict/route_revision_changed`, no
order transition occurs, and the app reloads the canonical route. The native
app also disables the optimistic next card immediately after a terminal proof
or failure until that refresh completes.
