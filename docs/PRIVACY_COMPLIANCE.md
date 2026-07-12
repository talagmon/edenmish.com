# Privacy compliance operations

Operational reference for Israel's Privacy Protection Law and Privacy Protection
Regulations (Data Security). This document records the current data inventory and
procedures; it is not a substitute for legal advice.

## Database definition and purposes

Owner/controller: Eden Arieli, exempt dealer 211568928, EdenMish, 111 Krinitzi,
Ramat Gan. The Worker + D1 database is the delivery source of truth. Its purposes
are order fulfilment, pricing, payment reconciliation, tracking, proof of delivery,
customer support, cancellations, fraud prevention, accounting, and legal claims.

Data subjects are customers, pickup/drop-off contacts, receivers, and the courier.
Data categories are contact details, addresses and coordinates, package and schedule
details, order/status history, payment references (not card data), live courier GPS,
proof of delivery, message metadata, ratings, rate-limit records, and cancellation
request data. The cancellation table stores only the last four ID digits.

## Processors and transfers

- Cloudflare: Worker, D1, Pages, security and hosting.
- Google Maps/Places: addresses, maps and route-related processing.
- Shopify and PayPlus: hosted checkout and payment processing.
- SendGrid: transactional email.
- Meta/WhatsApp: operational messages when that channel is used.
- Authorized courier/operations personnel: only information needed to deliver.

Some processors may process data outside Israel. Keep current processor agreements,
security terms, and transfer safeguards with the business records. Review this list
whenever an integration changes.

## Access and security

- Production access is limited to the business owner and specifically authorized
  operators; remove access promptly when no longer required.
- Secrets belong only in Cloudflare/GitHub secret stores or ignored local files.
- Review access, processors, incidents, and this database definition at least yearly
  and after a material system change.
- Record suspected incidents, contain them, preserve relevant evidence, assess risk,
  and notify the Privacy Protection Authority/data subjects when the law requires.

## Retention

The Worker's daily scheduled cleanup enforces:

- GPS pings: 30 days.
- Delivery photo/signature: cleared after 90 days unless exported and retained for
  an active dispute under a documented legal hold.
- Notification metadata and cancellation requests: one year.
- Expired rate-limit records: two days after last use and after any lock expires.

Core order, payment, status, and accounting records are retained for the statutory
accounting/claims period, then deleted or anonymized by the owner. Legal holds must be
documented and removed when the matter closes.

## Individual rights procedure

Requests arrive at eden@edenmish.com. Verify identity proportionately, locate records,
record the request and response, and provide access or correct inaccurate/incomplete
information under sections 13–14 of the Privacy Protection Law. Assess deletion
requests against statutory retention and third-party rights. Do not ask for a full ID
copy unless necessary; redact it when no longer needed.

## Monthly operator check

1. Confirm the cleanup cron has successful Worker runs.
2. Review authorized users and recent notification/security failures.
3. Delete resolved cancellation emails after the applicable retention period.
4. Review any legal holds and privacy requests.
5. Confirm the public privacy notice still matches actual integrations and behavior.
