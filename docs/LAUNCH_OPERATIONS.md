# Launch operations

Repository-owned checklist for the non-code launch work tracked by GitHub issue
[#6](https://github.com/talagmon/edenmish.com/issues/6). This document does not
replace the external account records or qualified legal advice.

## Status

| Area | Repository state | Human completion evidence |
|---|---|---|
| WhatsApp | Customer links and consent-gated notification plumbing exist. Automated Cloud API sends remain disabled until the account, templates, credentials, and end-to-end test in `WHATSAPP_OPERATIONS.md` are complete. | Verified Business account/number, reviewed app configuration, approved templates, controlled test evidence |
| GA4/GTM | The storefront has an explicit-consent loader and a non-PII event allowlist. An empty `GTM_CONTAINER_ID` disables measurement. | Account/container ownership, published configuration, consent/network test evidence |
| Meta Pixel | Supported only through the same consent-gated GTM boundary. It remains on hold until an authorized EdenMish Business Portfolio and Pixel/Dataset exist. | Authorized administrator, reviewed processing purpose, verified non-PII test evidence |
| Legal | Customer policies are published, but the planned Israeli attorney review cannot be completed in the repository. | Reviewer, date, reviewed versions, decisions, and separately tracked required changes |

## Scoped follow-ups

- [#213](https://github.com/talagmon/edenmish.com/issues/213):
  WhatsApp Business production setup and end-to-end verification.
- [#214](https://github.com/talagmon/edenmish.com/issues/214):
  consent-gated GA4/GTM conversion measurement.
- [#215](https://github.com/talagmon/edenmish.com/issues/215):
  Meta Pixel activation after authorized account setup.
- [#216](https://github.com/talagmon/edenmish.com/issues/216):
  final Israeli legal and operational launch review.

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
