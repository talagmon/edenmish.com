# WhatsApp conversation acceptance and remaining integration checks

This is the acceptance plan for the numbered, natural-language booking flow.
It does not authorize activation or external API spending. The last staging pilot
used deterministic interpretation, not Luna. Its transport success is not evidence
of live model quality. The new UX remains local/draft until reviewed.

## Customer behavior contract

- Friendly, concise Hebrew by default, with English support. Ask for the next
  missing detail; use already supplied information. Politely redirect unrelated
  requests to EdenMish delivery booking. Only reviewed business facts may answer
  service questions; the model cannot generate arbitrary answers.
- Numbered consent, size, suggested-time, address-choice, edit and review menus.
  Review menus use 1 Confirm, 2 Modify details, 3 Human help. `k`, `ok`, `okay`,
  `conf`, `confirm` and supported Hebrew acknowledgements mean 1 only against
  a currently displayed address/final review at the current revision. A question
  or qualified acknowledgement such as “ok but change the address” is not consent.
- Keys/envelopes can propose small size. Unknown, mixed or heavy descriptions
  need clarification. The final summary displays size and item notes for approval.
- Address punctuation is optional. Supported city-first addresses are accepted;
  street spelling is checked by the shared Maps resolver. Weak matches become
  numbered candidate choices, never an invented or silently selected address.
  Candidates need matching house number/city, Israeli country and in-area
  coordinates. Preserve remaining route/contact fields while resolving ambiguity.
- Today/tomorrow (including `tommorrow`) and dayparts produce concrete choices in
  Israel time using operating hours, the website's three-hour same-day lead and
  future pickup window. Explicitly identify an alternative day. Suggestions do
  not reserve capacity or guarantee availability. Selecting a time is still
  followed by address/complete-summary review.
- Edits revoke the quote/old summary consent. Backend quote revalidation remains
  mandatory; expiry or a price change requires fresh confirmation.
- A model proposes exact text spans only. It cannot confirm, choose an address or
  time, set a price, create/charge an order, report payment success, alter driver
  status, use a wallet, or access another customer's order.
- Human takeover pauses automation. Business-wallet requests, other orders and
  unsupported services require a person. Payment truth comes only from the
  canonical reconciled provider event. Never collect cards, IDs or credentials.

## Three complementary test layers

| Layer | Exercise | What it proves | Remaining limit |
|---|---|---|---|
| Local regression | Real conversation state machine, exact-span model fixtures, maps fixtures, canonical quotes/orders and SQLite-backed D1 adapter | Menus, confirmations, edits, retries, invalid inputs and downstream state invariants | Scripted model output is not live Luna quality; SQLite adapter is not remote D1 |
| Controlled WhatsApp conversation | Intended release model/prompt, real Twilio, real address lookup and canonical quote; stop at confirmed summary | Interpretation, address correction, response timing, copy and actual handset experience | No invoice, provider payment or driver execution is exercised |
| Provider sandbox rehearsal | Isolated test order/invoice, provider's test checkout and signed provider callback; driver dispatch and customer sends off | External checkout/webhook contract and canonical reconciliation | Test mode does not prove a live financial transaction or physical delivery |

Local tests already exercise a signed Twilio webhook through one canonical order
and mocked invoice, duplicate confirmation, amount/currency mismatch rejection,
paid-event deduplication, Ops visibility and pickup/dropoff route entries in a
local database. No real payment, email, driver task or customer message is sent.
Other regression cases cover stale quotes, failed checkout, receipt ordering,
operator takeover, sensitive-data rejection and durable pilot caps/expiry.

## Next live conversation: concrete acceptance script

Use only the explicitly approved tester, fictional contacts and public addresses.
Do not include other people's private information. Test these as uncoached turns:

1. “I need to send my keys or envelop.” Proposed small size and notes must be
   visible in the eventual summary, with an opportunity to change them.
2. “from tel aviv bni mosh 16 to ramat gan kernitzy 111 to eden”. Both addresses
   must be map-backed; ask the customer to select if uncertain. Eden is the
   recipient, not automatically the booking customer's name.
3. “tomorrow morning”. Offer eligible dated choices; do not silently pick one.
4. Reply using numbers, then `ok` at address review. No special command syntax.
5. Ask an unrelated question and a relevant pricing question. Redirect the first;
   explain the quote process for the second without inventing a price.
6. Choose Modify and change a field. Show the revised summary and authoritative
   quote, then accept `conf` only after that summary has been shown.
7. Exercise unknown address, unavailable day, model failure and human takeover.
   No stale confirmation, fabricated address or automated reply after takeover.
8. Final confirm ends the conversation-only test. Assert zero canonical orders,
   invoices, payment/email jobs and driver writes before and after the run.

Record aggregate turn counts, interpretation/fallback outcomes, latency and the
failed scenario IDs. Avoid retaining raw conversation bodies in reports. Require
all critical safety scenarios to pass, and repeat any failed UX scenario after a
fix. Measure model latency/fallback rate before choosing a production timeout;
the current bounded adapter timeout is not evidence of acceptable live latency.

## Gates still required before that live model test

- Verify the intended model is actually `gpt-6-luna`, endpoint access and usable
  latency with an approved bounded synthetic evaluation. Model contract fixtures
  do not satisfy the live evaluation gate.
- Review the exact current-message data transfer to OpenAI, privacy notice,
  retention and spending cap; provide secrets through the existing hidden flow.
  Never put keys or real customer data in the repo/report.
- Review the implemented [bounded Luna pilot](WHATSAPP_LUNA_PILOT.md). The legacy
  profile still rejects MODEL on; the new explicit `luna-v1` profile requires
  migration 040, immutable identity/window, serialized model spending and durable
  message/address limits. Its fixed readiness probes run with booking/sending off
  and consume the same forthcoming pilot budget. No activation is implied.
- Deploy only the reviewed staging version under explicit activation authority,
  verify authenticated operator pause, configure the incoming callback, start a
  new expressly approved window and supervise shutdown. Do not reset/reuse the
  previous pilot's counters or silently extend its budget.
- Provider sandbox rehearsal remains separate: verify test-mode capability and
  credentials before creating a test checkout. Do not assume a mocked invoice URL
  proves Shopify/PayPlus test-mode wiring. If unavailable, record that integration
  gap explicitly; no live charge is authorized by this plan.
- Production release still requires review of PR #306, migrations/config/privacy,
  provider verification and explicit production activation approval. No merge or
  production deployment is part of this change.
