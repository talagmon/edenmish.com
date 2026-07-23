# WhatsApp Business operations

Operational runbook for issue
[#213](https://github.com/talagmon/edenmish.com/issues/213). Customer-facing
WhatsApp text is in Hebrew; operator instructions and evidence remain in English.

## Current safety state

- `WHATSAPP_NUMBER` is public routing configuration for customer links and the
  operations recipient.
- `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are secrets. When either is absent,
  the Worker records an audit attempt as skipped and sends nothing.
- Customer delivery-proof links may use WhatsApp only when the order has the
  separate persisted phone-channel opt-in. Email remains the primary channel.
- The current Cloud API adapter sends free-form `text` messages. Proactive
  business-initiated messages outside the customer-service window generally need
  approved templates. Do not enable production credentials until #213 confirms
  the allowed service window or a scoped code change adds approved-template sends.

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

Only after the account/template decision above:

```bash
cd worker
wrangler secret put WHATSAPP_PHONE_ID
wrangler secret put WHATSAPP_TOKEN
```

Never pass the values on the command line, paste them into an issue, or store them
in `wrangler.toml`. Confirm secret names with `wrangler secret list`; that command
must not reveal values.

## Controlled verification

Use a test order and phone number owned by the operator. Do not use a real customer
record for activation testing.

| Case | Expected result |
|---|---|
| Either Cloud API secret absent | Notification audit records `skipped`; no network delivery |
| Delivery-proof opt-in false | Email job only; no WhatsApp proof-link job |
| Delivery-proof opt-in true | One email job and one WhatsApp job |
| Approved service/template send | Message arrives at the controlled test number and audit status becomes sent |
| Invalid/revoked credential | No customer retry storm; audit shows a sanitized failure |
| Paid-order operations alert | Eden receives one alert at the verified production number |

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
