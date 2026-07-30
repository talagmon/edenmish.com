# Driver notification catalog

This catalog adopts the EdenMish Hebrew notification voice as a product system:
short, operational, human, and calm. It does not enable every proposed sentence
as a remote push. The delivery channel must match the source and value of the
event.

## Product rules

- Title says what changed; body gives the useful next context.
- Operational alerts use one deterministic standard variant. Humor is reserved
  for non-critical in-app success moments, not randomized in remote pushes.
- Lock-screen content never contains customer names, phone numbers, addresses,
  cities, delivery IDs, notes, proof data, payment data, or session/device
  tokens.
- A push is a refresh signal. The authenticated route snapshot remains
  authoritative.
- Repeated route events share the `driver-route` thread and APNs collapse ID so
  the latest revision replaces obsolete work.
- Default operational urgency is APNs `active`. A future `time-sensitive`
  notification is allowed only for a server-proven event that affects the
  driver now or within one hour. Marketing is never time sensitive.
- Errors caused by the action currently visible in the app use an in-app alert
  or banner, not a redundant push.
- Marketing notifications require a separate explicit opt-in and an in-app
  setting independent from operational notification consent.

## Approved remote push copy

| Event key | Hebrew title | Hebrew body | APNs level | Target | Status |
| --- | --- | --- | --- | --- | --- |
| `driver_new_delivery` | משלוח חדש הוקצה לך | הפרטים מחכים באפליקציה | `active` | Current route | Implemented |
| `driver_route_updated` | המסלול עודכן | מומלץ לבדוק את סדר העצירות החדש | `active` | Current route | Implemented |

Both events use the generic hidden-preview fallback “יש עדכון חדש במסלול” if a
future notification extension or category-specific preview is introduced.

## Channel decision for the broader library

| Proposed event | Channel decision | Reason or prerequisite |
| --- | --- | --- |
| Several new deliveries | Future aggregated push | Derive from one route revision and show only a count if useful. |
| Reassigned delivery | Future generic route push | Requires a canonical reassignment event; no delivery identifier on lock screen. |
| Cancelled delivery | Future generic route push | Actionable route removal; do not expose customer or destination. |
| Delivery details changed | Future generic route push | Use generic copy and refresh the full route. |
| Address changed | Future high-priority route push | Only after server-side change classification; never display the address. |
| Pickup time changed | Future route push | Requires old/new schedule comparison and obsolete-event collapse. |
| Pickup reminder | Future scheduled push | Requires an authoritative server deadline and deduplication. |
| Arrived at pickup | Local/in-app | Device/geofence state; show the action in the active stop UI. |
| Pickup confirmed | In-app success | It acknowledges the driver action already visible on screen. |
| Pickup failed | In-app error | Errors belong beside the failed action. |
| Arrived at delivery | Local/in-app | Device/geofence state; show the action in the active stop UI. |
| Delivery completed | In-app success | Avoid notifying the driver about their own completed action. |
| Delivery failed | In-app workflow | Failure reason and disposition must remain in the controlled form. |
| Customer unavailable | In-app workflow | Driver-observed state; do not create a second notification loop. |
| Proof required | In-app blocking state | Keep the requirement next to the completion action. |
| Location unavailable | In-app system banner | Immediate device permission/remediation issue. |
| Offline | In-app connectivity banner | Local network state, not a server push event. |
| Sync completed | Subtle in-app state | Low value as an interruptive notification. |
| Sync failed | In-app banner | Preserve queued work and explain retry beside sync status. |
| Route optimization changed | Existing route push | Covered by `driver_route_updated`. |
| Exceptional delay | Future route push | Requires reliable ETA comparison and rate limiting. |
| Driver inactive during shift | Future operational push | Requires a reviewed inactivity threshold and false-positive handling. |
| Shift started | In-app state | The driver initiated or can already see the shift. |
| Shift ended | In-app state | The driver initiated or can already see the result. |
| App update available | Future informational push | Prefer App Store/update UI; push only for a material compatibility deadline. |
| Sign-in required | In-app authentication state | A stale unauthenticated device must not receive targeted route data. |
| Missing document | Future account notification | Requires a separate account/compliance destination, not the route thread. |
| Exceptional shipment issue | Future generic push | Requires a concrete event key, owner, urgency, and destination screen. |
| General system update | Do not implement generically | Every notification needs a specific user-valued event. |

## Dynamic data policy

The proposed placeholders `{first_name}`, `{delivery_id}`, `{customer_name}`,
`{pickup_time}`, `{window_start}`, `{window_end}`, `{city}`, `{area}`, and
`{route_name}` are not permitted in remote lock-screen copy. `{count}` may be
used for a future aggregated new-delivery notification after product validation.
All detailed values remain inside the authenticated app.

## Expansion checklist

Before adding a new remote event:

1. Define one stable event key and its canonical backend source.
2. Prove that the event is useful when the app is closed.
3. Define deduplication, collapse behavior, expiration, and stale-event handling.
4. Assign `passive`, `active`, or narrowly justified `time-sensitive` urgency.
5. Map the tap to an authenticated destination that reloads server state.
6. Add exact Hebrew copy, privacy, payload, and rate-limit tests.
7. Add a per-category setting before enabling informational or marketing pushes.
