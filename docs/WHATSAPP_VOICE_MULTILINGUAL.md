# Voice notes and multilingual booking — local implementation, 10 October 2026

## Status

The initial implementation was deployed for the approved 10 October staging
session. That session closed automatically after a model validation failure;
automation was disabled and the temporary key removed. It also exposed an audio
webhook failure. The follow-up fixes below are local only, not deployed.

The webhook now accepts both SM and MM message IDs while preserving signature,
account, recipient and resource identity validation. Complete Hebrew sized-item
phrases such as `מעטפה קטנה` now produce the canonical size and retain the item
in notes. Existing notes and explicit notes take precedence. Full-phrase matching
continues to reject negation, alternatives, unsupported items and weight limits.

The original repair passed 892 Worker tests, including 13 new regressions and 33 targeted cases.
The voice Worker tests now enter through a signed MM webhook instead of bypassing
the transport parser. MP3 and OGG coverage includes local D1, duplicate suppression,
consent/expiry checks, mocked transcription and mocked Sol. A synthetic Hebrew
request advances in Hebrew and keeps the envelope description. Local tests made
no paid provider calls. They do not establish real speech recognition quality.

Claude subsequently found five short-quote size-context gaps. The first repair
passed 928 tests, but independent review requested further changes. Revision 2
addresses punctuation/self-correction, Latin/multilingual weight units, basic
ambiguity checks across all five languages and mixed input, and false positives
for common scheduling/contact alternatives and negative delivery notes.

Revision 2: 86 new fixtures across validator, typed booking and signed MM voice
paths; 258 added tests. All 1,186 Worker tests pass; 299 focused validator/grounding
tests pass. Four bare-size voice controls bypass Sol after transcription; the other
82 use mocked Sol. All providers are mocked; $0 spend. No orders are created.
One old corpus case (my keys; your keys) now rejects as size evidence; its unique
longer quote grounding check remains covered using notes.

Bounded lexicons are not complete multilingual semantic validation. Unlisted items,
dialects and indirect corrections remain limitations. Whole-turn weight and some
correction/negative-note checks remain conservative. Existing uncertainty still
stops the live test grant; no clarification/retry policy change. Live transcription
response shape, quality and native recording remain unverified.

Independent re-review remains pending. The review handoff and freshly rerun full
logs are tracked in [the revision 2 review package](reviews/whatsapp-size-context-r2/README.md).
Publication is for review only, without deployment or activation. A future test
requires independent review, separately authorized staging deployment and a fresh
bounded grant. Do not reuse or reset any closed grant.

The selected path is Twilio WhatsApp audio → `gpt-transcribe` → the existing
`gpt-6.1-sol` low structured proposal → canonical booking validation → fixed
customer copy. Typed and transcribed input share the draft, missing-field logic,
address checks, quote expiry, edit flow and human handoff.

## Language behavior

Supported customer languages: Hebrew (`he`), Arabic (`ar`), Russian (`ru`), French
(`fr`), English (`en`). The feature is selected by
`WHATSAPP_BOOKING_MULTILINGUAL_ENABLED=on`; default configs remain unchanged.

Before consent, deterministic greeting/request detection selects fixed copy. After
consent, the same Sol call that extracts fields proposes a reply language in
schema version 4, together with a bounded reply style. Versions 2 and 3 remain
validator-compatible legacy contracts; new multilingual requests require version 4. Explicit preferences are
sticky; otherwise conversational vocabulary and the model's context-aware choice
can switch the language. Numbers, short acknowledgements, addresses and borrowed
words are not sufficient reasons to switch. Stored values/history are not sent to
the model: only field presence, current language, preference flag, current message
previous reply style, active field name, and the existing approved facts/time context.

Arabic/Russian/French prompts, menus, service facts, summaries, handoffs and
payment status copy are fixed translations. Model prose never becomes the reply.
Names, street names and item descriptions are not translated. Exact city aliases
normalize known service-area localities; all addresses still require the existing
resolver and customer review. Relative dayparts offer explicit time choices;
unsupported/ambiguous expressions ask for clarification. Broad dialect and
transliteration coverage is not claimed by the local fixtures.

## Everyday conversation and efficient completion

The goal is a short, friendly, everyday exchange that reaches a correctly
confirmed delivery with as little effort as possible. The same Sol call selects
`reply_style`: friendly by default, brief for a request for speed/brevity, guided
for confusion or a request to explain. Short factual answers retain the current
approach; subsequent messages can change it. This is an interaction preference,
not a customer personality profile. Instructions prohibit demographic or ability
inferences from language, accent or grammar.

Reviewed conversational copy supports all five languages. Friendly and brief
flows can ask pickup and destination together when both are missing and the
model adapter is available; guided flows ask one field at a time. Edits and
ambiguous evidence always get a single targeted question. A single-address answer
is still accepted. Every supplied field is checked, and the next question skips
collected details. No extra model request, wider output limit, or new spend
allowance is introduced. Explicit numeric confirmation and authoritative pricing
remain required. Being in a hurry never implies an available delivery time.

This implementation selects bounded conversational copy; Sol does not write
unrestricted customer replies. Local mocked decisions verify behavior, not real
Sol judgment or perceived naturalness. The paid rehearsal must assess whether
Sol chooses the right style, asks few enough questions, handles corrections, and
sounds natural to speakers of each language. Broader generative dialogue would
be a separate design change with grounding and regression work.

`node worker/scripts/replay-booking-conversation.mjs` generates 15 examples from
the current engine with prescribed style choices. The $1.65 proposed test ceiling
is unchanged; use the existing typed followups to test speed/help requests.

## Audio boundary

- Incoming webhook signature, account, sender, recipient and timestamp are checked
  before exposing a single audio descriptor. Its URL must match the signed
  account/message's exact Twilio media path.
- New consent copy discloses that recordings go to OpenAI. No audio is fetched or
  transcribed before this disclosure and a text consent action. Older drafts ask
  for audio consent separately. A first-message `start` does not authorize audio.
- Download happens under the existing conversation lease and event deduplication.
  Only HTTPS Twilio media is authenticated. A single signed `*.twiliocdn.com`
  redirect may follow without the Twilio Authorization header. Other destinations
  and further redirects fail closed.
- Max file size 2 MiB; max parsed duration 60 seconds. Supported: WhatsApp OGG/Opus
  voice notes, PCM WAV, MP3. M4A, video and other attachments ask for supported
  audio or typed text. OGG is checked for CRC, sequencing and a single Opus stream;
  duration comes from packets. The Worker losslessly remuxes it to WebM, which the
  transcription endpoint accepts. No FFmpeg runtime/service is needed.
- Download/transcription share a 20-second abort deadline. The endpoint/model are
  fixed; the request carries five language hints and no stored customer context.
  Empty, unknown-language, oversized, malformed, sensitive or unaccounted
  transcripts do not enter the booking flow. No retries or model fallback spend.
- The full recording and transcript are transient in this app; only validated
  booking fields persist under existing draft retention. Twilio/OpenAI retention
  is provider-controlled and is not changed by this implementation.
- Voice can fill/correct details and request help. A spoken final confirmation
  asks for the displayed number **by text**. No transcription can directly create
  an order or payment; the conversation-only pilot never creates either.

## Disabled by default and independent allowance

Voice additionally requires `WHATSAPP_BOOKING_VOICE_ENABLED=on`,
`WHATSAPP_BOOKING_VOICE_APPROVED=on`, `WHATSAPP_BOOKING_VOICE_GRANT_ID`, migration
045, staging, conversation-only mode, driver dispatch OFF, one allowlisted test
phone, the existing scoped OpenAI credential, and a matching unexpired database
grant. Customer traffic never creates grants. Binding covers the session IDs,
account, sender, allowlist, fixed model and media limits.

The new audio ledger permits at most 6 files in 15 minutes and reserves **$0.005
per attempt** ($0.03 total). Its transaction trigger reserves before media IO;
replays, failed downloads, timeouts and uncertain outcomes never refund holds.
Failure stops that audio grant. Expiry and existing continuation authorization
are rechecked before each network step and before accepting the transcript.
Historical continuation tables/caps are not reset or expanded by this change.

The previous version-4 Sol grant permits only 4 model calls and has expired. The
larger test plan below is a **proposal**, not an active grant. Activation needs a
separately reviewed fresh continuation profile matching these counters, prior
ledger reconciliation, staging deployment, temporary key and shutdown supervision.
The old grant must not be stretched/reused as authorization for this plan.

## Local evidence and remaining real-world checks

Run `npm test` from worker. New tests cover all five languages plus mixed input,
whole conversation-only replays, source quote grounding, city aliases, dayparts,
explicit preferences, localization, menu ambiguity, voice confirmation, signed
Twilio parsing, consent, stale/off/binding gates, actual workerd + D1 + mocked
transcription/Sol, duplicate suppression, redirect isolation, retained failures,
concurrent budget reservations, and zero orders.

`node worker/scripts/replay-booking-multilingual.mjs` emits the actual offline
conversation replays. Media fixtures are synthetic tones; prescribed transcripts
are fixtures. They prove pipeline behavior, not recognition accuracy, dialect
coverage, provider availability, native-speaker copy quality or live latency.
The generated WebM was independently decoded locally with FFmpeg/FFprobe.

Real pilot acceptance: record short Hebrew, Arabic, Russian, French, English and
mixed-language notes; check street/house numbers, negation, times and corrections;
check code switching and background noise; verify graceful typed fallback and
human handoff. Measure real end-to-end latency and provider-reported usage. An
initial smoke test is not a production language-quality evaluation.

## Proposed WhatsApp test allowance (USD)

Recommend a **$1.65 total test ceiling** for one allowlisted phone, a fixed
15-minute session, 6 voice notes (at most 60 seconds each), 12 Sol-low calls,
24 incoming and 24 outgoing messages, and 4 address lookups. No automatic retries,
orders, checkout, email or driver dispatch. Six voice notes exercise the five
languages and one mixed-language case; typed followups exercise switching,
clarification and the final confirmation. Use one shared draft and at most four
map lookups, rather than repeating six full address-booking flows.

| Component | Calculation / reservation policy | Maximum allowance |
|---|---|---:|
| Transcription | 6 × $0.005 retained hold; tariff $0.0045/min | $0.030000 |
| Sol low | 12 × existing conservative $0.056320 hold | $0.675840 |
| WhatsApp | 24 × $0.010300 inbound + 24 × $0.011300 outbound holds | $0.518400 |
| Address lookup | 4 × existing $0.032000 hold | $0.128000 |
| Additional fee contingency | Fixed cushion | $0.250000 |
| Total reserved estimate | | **$1.602240** |
| Recommended ceiling | Includes $0.047760 rounding headroom | **$1.650000** |

The model reservation uses 16,384 input tokens, 1,024 output tokens, conservative
$2.50/$10 per million, plus 10%; current published short-context Sol Standard
input is $2.00 per million, so the existing hold remains conservative. The 8 KiB
request cap and output limit remain; input allowance is not a provider-enforced
token cap. All maximum holds are retained even if observed usage is lower.

At published tariffs, six full minutes of transcription cost $0.027 and 48
WhatsApp messages have a $0.24 Twilio handling fee before Meta/other applicable
fees. Messaging/map line items above reuse conservative pilot reserves, not an
invoice or a claim of a new tariff. Fees vary by category/destination/account.
This is the complete proposed allowance, not an instruction to purchase credits.
Reconcile any unused earlier approved balance before deciding the additional
amount to authorize; no historical hold is silently reclaimed here.

Sources checked 10 October 2026:
- https://developers.openai.com/api/docs/models/gpt-transcribe
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/pricing
- https://www.twilio.com/en-us/whatsapp/pricing

## Authorized staging rehearsal

On 10 October the owner approved staging deployment and one 15-minute test
with a fresh $1.65 ceiling, no real orders or payments. Version 5 uses migration
046 and retains all v1–v4 rows. Its maximum new operation holds are $1.322240;
$0.03 is separately reserved for the six-file audio ledger and $0.25 for fees.
The local suite passed 879 tests, including quota saturation, concurrent duplicate
reservation, exact expiry and predecessor immutability. Actual provider quality
and voice-note latency remain for this live rehearsal.

The staging configuration uses compact `WHATSAPP_BOOKING_VOICE_PROFILE` to
stay below Cloudflare's environment-binding limit. `off` disables voice and
multilingual behavior; `v5-20261010` expands the fixed approved v5 settings.
Unknown values fail closed. The continuation window, consent, allowlist and
independent audio ledger remain mandatory. Production configuration is unchanged.
