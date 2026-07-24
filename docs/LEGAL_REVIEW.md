# Final legal review packet

Preparation checklist for issue
[#216](https://github.com/talagmon/edenmish.com/issues/216). Repository contributors
can assemble evidence and implement approved wording, but only a qualified Israeli
attorney can complete the planned legal review.

## Materials to provide

- current Terms of Service;
- privacy policy and consent wording;
- refund/cancellation policy and online cancellation form;
- accessibility statement and operational contact details;
- booking, payment, receipt/invoice, tracking, proof-of-delivery, redelivery, and
  failed-delivery flows;
- retention schedule and individual-rights procedure from
  `PRIVACY_COMPLIANCE.md`;
- processor list: Cloudflare, Google, Shopify/PayPlus, SendGrid, GreenInvoice when
  active, and Meta/WhatsApp when active;
- the analytics and WhatsApp runbooks, including the explicit-consent boundaries.

Provide dated production copies rather than relying only on source files. Keep
privileged advice, identity documents, contracts, credentials, and customer data
outside this public repository.

## Questions requiring counsel

1. Are controller identity, contact details, service terms, cancellation rights,
   pricing/payment disclosures, and effective dates complete and prominent?
2. Do the retention periods and legal-hold process satisfy applicable Israeli
   privacy, accounting, consumer, and limitation requirements?
3. Are the lawful bases, consent language, processor disclosures, international
   transfer disclosures, and individual-rights procedure sufficient?
4. Is the separate WhatsApp service-message opt-in appropriate for the proposed
   message types and provider setup?
5. Is the analytics consent model sufficient for GA4 and, if later enabled, Meta
   Pixel? Are any additional records or withdrawal controls required?
6. Are proof-of-delivery media, receiver details, live location, failed-delivery
   disposition, redelivery fees, and business-wallet terms described adequately?
7. Are accessibility and records-retention responsibilities assigned clearly?

## Completion record

Record only:

- reviewer name/firm or an internal reference to the retained engagement record;
- review date;
- exact policy versions/effective dates reviewed;
- outcome: approved, approved with changes, or further review required;
- links to separately scoped GitHub issues for public implementation work.

Do not paste legal advice into GitHub. If the reviewer identifies required work,
#216 and the umbrella issue remain open. They can be checked only after every
required change is deployed, dated copies are archived, and the reviewer confirms
the final published versions.

Owner confirmation: on 2026-07-24, the owner confirmed that all applicable
legal/privacy add-ons were approved. Reviewer identity, privileged advice,
engagement records, and archived policy copies are retained outside this public
repository.
