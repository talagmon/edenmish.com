# EdenMish staging security assessment rules

This is an authorized, non-destructive assessment of the checked-out EdenMish
source code and `https://ops-staging.edenmish.com` only.

## Allowed scope

- The local checked-out repository.
- `https://ops-staging.edenmish.com` and same-origin paths.

## Prohibited actions

- Do not access or test production hosts, including `edenmish.com`,
  `ops.edenmish.com`, `find.edenmish.com`, or `pay.edenmish.com`.
- Do not follow or test Shopify, payment-provider, email-provider, Google, or
  other third-party endpoints.
- Do not make purchases, create payable checkouts, invoke real webhooks, send
  email, alter DNS, or attempt denial-of-service, credential stuffing, or
  brute-force attacks.
- Do not modify or delete persistent data. Keep request volume low and stop if
  the target becomes unstable.
- Do not print, retain, or exfiltrate credentials, tokens, personal data, or
  environment secrets. Redact sensitive values in all findings.

## Priorities

- Broken access control, IDOR, authentication and session weaknesses.
- Business coupon enforcement, especially one redemption per business account,
  cross-account reuse, plan-scope bypass, and amount manipulation.
- Wallet and checkout state-transition validation without completing payment.
- Injection, XSS, CSRF, SSRF, insecure CORS, secret exposure, and rate-limit
  bypasses relevant to the OWASP Top 10.
- Report reproducible evidence and remediation guidance, but do not exploit a
  finding beyond the minimum safe proof required to validate it.
