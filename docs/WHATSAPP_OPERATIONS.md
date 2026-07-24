# WhatsApp Business operations

Operational runbook for issue
[#213](https://github.com/talagmon/edenmish.com/issues/213). Customer-facing
WhatsApp text is in Hebrew; operator instructions and evidence remain in English.

## Current safety state

- `WHATSAPP_NUMBER` is public routing configuration for customer links and the
  booking CTA only. It is never an automated operations recipient.
- `WHATSAPP_OPS_RECIPIENT` is a separate secret internal recipient.
- `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are shared transport secrets. When
  either is absent, the Worker records an audit attempt as skipped and sends
  nothing.
- Customer delivery-proof links may use WhatsApp only when the order has the
  separate persisted phone-channel opt-in. The provider template contains no
  proof URL or tracking token; email/tracking remains the private detail channel.
- Proactive messages use approved `template` transport only. Both supported
  templates have zero dynamic components.
- Paid-order alerts are unique durable jobs. The provider receives only the
  separate operations number and generic approved template—no name, address,
  order ID, tracking token, price, URL, or free text.
- Delivery receipts require a valid Meta app-secret signature and update only a
  sanitized provider reference, lifecycle status, provider timestamp, and numeric
  error code. Duplicate/stale receipts are no-ops.
- Meta necessarily receives the destination phone number to route a message. That
  transport address is covered by the approved service-message boundary, is never
  a template component, and is not retained in EdenMish's WhatsApp audit rows.

The owner confirmed the applicable legal/privacy add-ons as approved on
2026-07-24. Production credentials must still remain unset until the account,
recipient, templates, webhook, and controlled-test setup below are complete.

## Business account checklist

The account owner must complete these steps in the WhatsApp Business/Meta admin:

1. Confirm that the displayed business name and production number match the public
   EdenMish contact details.
2. Enable multi-factor authentication for administrators and record a recovery
   owner outside GitHub.
3. Review administrator access and remove unused people, system users, and tokens.
4. Configure business hours and an away message.
5. Configure quick replies and lead/order labels.
6. If Cloud API automation is enabled, use a least-privilege system user, approve
   the required service-message templates, and record token rotation ownership.

Suggested away-message draft (replace the bracketed hours before publishing):

> תודה שפניתם ל‑EdenMish. כרגע איננו זמינים. שעות הפעילות הן [שעות
> הפעילות]. אפשר להשאיר כתובת איסוף, כתובת מסירה, מועד מועדף ותיאור קצר של
> הפריט — ונחזור אליכם בהקדם. אין לשלוח בצ׳אט מסמכים רגישים או פרטי תשלום.

Suggested quick replies:

| Shortcut | Purpose | Draft |
|---|---|---|
| `/details` | Missing booking details | כדי לבדוק זמינות ומחיר, נא לשלוח כתובת איסוף, כתובת מסירה, מועד מועדף ותיאור קצר של הפריט. אין לשלוח פרטי כרטיס או מסמכים רגישים. |
| `/payment` | Payment boundary | התשלום מתבצע רק בקישור המאובטח של EdenMish/Shopify. לעולם לא נבקש פרטי כרטיס בוואטסאפ. |
| `/tracking` | Tracking boundary | קישור המעקב נשלח לאחר אישור התשלום. פרטים אישיים בעמוד המעקב עשויים לדרוש אימות בדוא״ל. |
| `/delay` | Operational delay | יש עיכוב במסירה. נעדכן כאן ברגע שיהיה מועד חדש ונמשיך לעדכן עד להשלמה. |
| `/privacy` | Privacy request | לבקשות עיון, תיקון או פרטיות אפשר לפנות ל‑eden@edenmish.com. אין לשלוח בצ׳אט צילום תעודה מלא אלא אם התבקשתם לכך במפורש. |

Recommended labels:

1. `ליד חדש` — new lead, details not yet reviewed.
2. `חסרים פרטים` — waiting for customer details.
3. `הצעת מחיר נשלחה` — quote sent.
4. `ממתין לתשלום` — payment link sent, not confirmed.
5. `שולם / תואם` — paid and scheduled.
6. `במשלוח` — active delivery.
7. `הושלם` — completed.
8. `דורש טיפול` — exception, complaint, redelivery, or refund.
9. `בוטל` — cancelled.

## Cloud API credential setup

Complete migration 030 and approve both zero-component templates before adding
these values:

```bash
cd worker
wrangler secret put WHATSAPP_PHONE_ID
wrangler secret put WHATSAPP_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_WEBHOOK_VERIFY_TOKEN
wrangler secret put WHATSAPP_OPS_RECIPIENT
wrangler secret put WHATSAPP_OPS_PAYMENT_TEMPLATE
wrangler secret put WHATSAPP_OPS_TEMPLATE_LANGUAGE
wrangler secret put WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE
wrangler secret put WHATSAPP_CUSTOMER_TEMPLATE_LANGUAGE
```

Never pass the values on the command line, paste them into an issue, or store them
in `wrangler.toml`. Confirm secret names with `wrangler secret list`; that command
must not reveal values.

### Required template contracts

| Secret name | Suggested approved template | Components | Required content boundary |
|---|---|---:|---|
| `WHATSAPP_OPS_PAYMENT_TEMPLATE` | `eden_ops_payment_received` | 0 | Generic notice that a paid delivery needs review in the authenticated ops dashboard |
| `WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE` | `eden_delivery_complete` | 0 | Generic delivery-complete notice directing the customer to the previously supplied email/tracking channel |

Do not add body/header/button variables to either template without a new privacy
review and matching bounded-component code/tests.

Register `https://find.edenmish.com/webhooks/whatsapp` for delivery-status
webhooks. The GET challenge uses `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; POST receipts
must carry Meta's valid `X-Hub-Signature-256`.

The Worker pins Graph API `v25.0`. It was checked against Meta's official Graph
endpoint on 2026-07-24; `v25.0` was recognized and `v26.0` was not. The Worker
owner must re-check the
[Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog/)
quarterly and before Meta's published version-expiry date, then update the pin
and provider-contract tests in one PR.

## Controlled verification

Use a test order and phone number owned by the operator. Do not use a real customer
record for activation testing.

| Case | Expected result |
|---|---|
| Either shared Cloud API secret absent | Notification audit records `skipped`; no network delivery |
| Only operations class configured | Customer class remains disabled |
| Only customer class configured | Operations class remains disabled |
| Delivery-proof opt-in false | Email job only; no customer WhatsApp template job |
| Delivery-proof opt-in true | One email job and one zero-component customer-template job |
| Approved service/template send | The approved template arrives at a controlled test number; audit records a sanitized provider reference/status |
| Invalid/revoked credential | No customer retry storm; audit shows a sanitized failure |
| Duplicate paid event | Exactly one operations outbox job and provider send |
| Paid-order operations alert | Eden receives one zero-component alert at the separate verified operations recipient |
| Duplicate/stale receipt | No duplicate or backward audit transition |

Record the date, environment, order fixture ID, notification audit result, and a
redacted provider message ID. Do not record message bodies, phone numbers, tokens,
or customer data in GitHub.

## Disable and recover

If unexpected messages, consent violations, or credential exposure are suspected:

1. Revoke/rotate the Meta token.
2. Remove or rotate the Worker secrets.
3. Confirm new attempts are skipped rather than sent.
4. Preserve sanitized notification audit metadata.
5. Follow the privacy incident procedure in `PRIVACY_COMPLIANCE.md`.
