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
| `GOOGLE_ROUTE_OPTIMIZATION_API_KEY` | Worker secret | Restricted server-side credential |

Set a low Google Cloud quota and restrict the key to the Route Optimization API.
Do not put the API key in Flutter, repository files, URLs, or logs.

The current module is the provider and validation boundary. A following PR must
wire it to authenticated ops dispatch, persist a new immutable route revision,
and notify the driver app. No production service or billing is enabled by this
change.
