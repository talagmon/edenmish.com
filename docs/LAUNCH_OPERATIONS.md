# Launch operations

Repository-owned checklist for the non-code launch work tracked by GitHub issue
[#6](https://github.com/talagmon/edenmish.com/issues/6). This document does not
replace the external account records or qualified legal advice.

## Status

| Area | Repository state | Human completion evidence |
|---|---|---|
| WhatsApp | Privacy-safe approved-template classes, separate operations routing, durable retries, and signed receipt audit are implemented. Automated sends remain disabled until migration 030, #216's retained activation evidence, account/template setup, and the controlled test in `WHATSAPP_OPERATIONS.md` are complete. | Dated #216 completion record, verified Business account/number, reviewed app configuration, approved templates, controlled test evidence |
| GA4/GTM | The storefront has an explicit-consent loader and a non-PII event allowlist. An empty `GTM_CONTAINER_ID` disables measurement. Activation remains blocked by code prerequisite #219 and legal gate #216. | Account/container ownership, published configuration, consent/network test evidence |
| Meta Pixel | Supported only through the same consent-gated GTM boundary. It remains on hold until an authorized EdenMish Business Portfolio and Pixel/Dataset exist. | Authorized administrator, reviewed processing purpose, verified non-PII test evidence |
| Legal | The owner confirmed the legal/privacy add-ons for the current non-analytics launch scope approved on 2026-07-24. This does not activate or approve deferred GA4/Meta work. Issue #216 remains open until its retained-evidence and final-published-version criteria are recorded complete. | Dated retained review record and approved policy versions outside GitHub |

## Scoped follow-ups

- [#213](https://github.com/talagmon/edenmish.com/issues/213):
  WhatsApp Business production setup and end-to-end verification.
- [#214](https://github.com/talagmon/edenmish.com/issues/214):
  consent-gated GA4/GTM conversion measurement.
- [#215](https://github.com/talagmon/edenmish.com/issues/215):
  Meta Pixel activation after authorized account setup.
- [#216](https://github.com/talagmon/edenmish.com/issues/216):
  final Israeli legal and operational launch review.
- [#218](https://github.com/talagmon/edenmish.com/issues/218):
  WhatsApp privacy, approved-template, recipient, and reliability hardening.
- [#219](https://github.com/talagmon/edenmish.com/issues/219):
  authoritative paid conversion and sensitive-URL analytics protections.

The umbrella issue stays open until the evidence from each applicable follow-up
is linked back to it. A code merge, secret name, or screenshot of an account page
is not by itself proof of end-to-end delivery, consent behavior, or legal review.

## Evidence rules

Store only non-sensitive evidence in GitHub:

- UTC/local date, environment, tested behavior, and pass/fail result;
- public IDs such as a GTM container ID only when needed;
- redacted screenshots without customer data, tokens, phone-number IDs, or account
  recovery information;
- links to scoped code changes and deployment runs.

Keep credentials, identity documents, privileged legal advice, customer messages,
and provider recovery material outside the public repository.
