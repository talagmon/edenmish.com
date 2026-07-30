# Driver push notifications

The native driver app receives privacy-safe Apple Push Notification service
(APNs) alerts when a new delivery is added to the active route or an existing
route changes. The notification is a wake-up signal only: the app always reloads
the authenticated route snapshot and never treats notification data as the
canonical delivery record.

## Runtime flow

1. After a driver signs in, the app asks for notification permission and calls
   `registerForRemoteNotifications()`.
2. The app sends its APNs token, `aps-environment`, and exact bundle ID to
   `POST /api/driver/v1/push-devices` with the normal bearer token and
   installation headers.
3. A canonical order or execution-event change causes the Worker to reconcile
   the active route.
4. If the immutable route revision changed, the Worker sends one collapsed APNs
   alert to each active registration for that driver.
5. Foreground, background, and notification-tap handling all request a fresh
   route snapshot in the app.
6. Sign-out calls `DELETE /api/driver/v1/push-devices`; invalid APNs tokens are
   disabled server-side and registrations unseen for 90 days are removed.

Notifications contain only `type`, `shift_id`, `route_revision`, and generic
Hebrew alert text. They never contain customer names, phone numbers, addresses,
notes, payment data, proof media, session tokens, or device tokens.

## Driver API

Both operations require the same bearer authorization, `X-Driver-Installation-Id`,
and request metadata as the rest of Driver API v1.

`POST /api/driver/v1/push-devices`

```json
{
  "device_token": "<lowercase-or-uppercase-hex-APNs-token>",
  "environment": "development",
  "app_bundle_id": "com.edenmish.edendriver.nativebeta"
}
```

The environment must be `development` or `production`, and the bundle ID must
appear in `APNS_ALLOWED_TOPICS`. Success returns `{ "registered": true }`.

`DELETE /api/driver/v1/push-devices` removes the registration associated with
the authenticated installation and returns `{ "removed": true|false }`.

## Apple and Cloudflare setup

1. In Apple Developer Certificates, Identifiers & Profiles, enable **Push
   Notifications** for both explicit App IDs:
   `com.edenmish.edendriver.nativebeta` and `com.edenmish.edendriver`.
2. Regenerate both App Store provisioning profiles after enabling the
   capability. Their signed entitlements must include `aps-environment`.
3. Create an APNs signing key and download its `.p8` file once. Keep it outside
   the repository and password manager-share it only with release operators.
4. Apply `worker/migrations/037_driver_push_devices.sql` to staging, then
   production, before deploying the Worker.
5. Store the APNs values as encrypted Worker secrets:

```bash
cd worker
wrangler secret put APNS_TEAM_ID
wrangler secret put APNS_KEY_ID
wrangler secret put APNS_PRIVATE_KEY_P8
```

For staging, create the GitHub `staging` environment secrets
`STAGING_APNS_TEAM_ID`, `STAGING_APNS_KEY_ID`, and
`STAGING_APNS_PRIVATE_KEY_P8`. The staging deployment workflow maps these to the
Worker secret names and accepts only the native-beta topic.

APNs auth keys work with both sandbox and production endpoints. The app derives
`development` versus `production` from its signed `aps-environment` entitlement;
the Worker does not guess the endpoint.

## Release verification

Use a physical device because the production acceptance gate must validate the
signed entitlement, provisioning profile, and real APNs delivery:

1. Install the native-beta build, sign in, and allow notifications.
2. Add a paid delivery to the active driver route. Confirm a generic “new
   delivery” alert arrives and opening it refreshes the route.
3. Change an assigned delivery or complete a pickup from another client.
   Confirm a generic “route updated” alert and a fresh route revision.
4. Keep the app foregrounded and repeat; confirm the banner appears and the
   route updates without a relaunch.
5. Sign out, then update the route again; confirm that installation no longer
   receives notifications.
6. Inspect Worker logs only for aggregate delivery errors. Device tokens and
   notification payloads must never be logged.

APNs delivery is best effort. Missing APNs configuration or a transient APNs
failure must not block order changes, driver event acceptance, route
optimization, email, SMS, or WhatsApp processing. The app still refreshes the
route on launch and through its existing update stream.
