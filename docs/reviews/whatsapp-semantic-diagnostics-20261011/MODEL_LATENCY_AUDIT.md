# Model and latency audit — local evidence, no provider experiment

Audit date: 2026-10-11. API configuration is `gpt-6.1-sol`,
`reasoning:{effort:'low'}`, `service_tier:'default'`, `store:false`, Responses API
`https://api.openai.com/v1/responses`. This is the application API request, not a
ChatGPT UI model choice or ChatGPT subscription. The recorded response passed the
exact returned-model and tier checks. No SDK call, automatic SDK retry, model
routing, tools, prior response, counting call or hidden conversation history is
used by this preflight. Low effort is serialized in the pinned request; zero
reported reasoning tokens does not establish that the setting was ignored.

## What the retained r2 evidence proves

The immutable report records `failed/semantic_mismatch`, input 1181, cached 0,
output 149, reasoning 0, legacy `providerLatencyMs:8500`, `endToEndMs:9781` and
`secretPersisted:false`. Both full failed preflight reservations remain held.
The actual raw response, field values and provider processing timestamps were
not retained; do not reconstruct them from guesses or private transcripts.

By code-path inference, semantic comparison was reached after HTTP success,
bounded body parsing, exact model/tier and bounded usage checks, response envelope
validation, proposal JSON parsing and strict evidence/business validation.
`bookingModelEnvelope` requires status `completed`, no error/incomplete details,
exactly one completed assistant message (with at most one additional reasoning
item), one output-text content item, and at most 8000 text characters. Therefore
this failure was neither a transport timeout nor an incomplete-output rejection.
Status/incomplete reason were not separately stored in r2; this is a code-path
inference, not a retrospective raw-response observation. The report does not
prove all nine expected fields were extracted or which field/style/version check
failed.

The demonstrated local oracle defect rejects grounded alternatives explicitly
permitted by the prompt: full item-description notes, pickup context words and
recipient punctuation. It is a real independently tested defect, but NOT proof
that one of those alternatives caused the actual r2 mismatch. The strict runtime
validator remains unchanged. Only this exact fixture's semantic oracle admits
reviewed alternatives after strict validation.

## Actual clocks and caps

The old `providerLatencyMs` clock starts AFTER the initial OFF check and durable
reservation, BEFORE a second remote OFF check. It includes that second check,
then network + provider + full response read. It is not provider-only processing
latency. The 10s transport timer starts AFTER the second OFF check, but an existing
post-read gate also rejects if total elapsed since the earlier start is>=10s.
This effectively leaves less than 10s transport time after a slow second check.
We preserve both existing deadlines in r3; no extension is proposed.

`endToEndMs` uses that same post-reservation start and additionally includes
validation, any final OFF check and durable settlement. It excludes startup/key
selection, initial OFF check and reservation. It is not handset/customer latency.
Neither8.5s nor9.781s is a provider compute-time measurement. No exact attribution
to network, queue, model thinking or D1 can be made from r2.

The output cap is 1024 total generated tokens, including reasoning; 149 were
reported, of which 0 reasoning. Input engineering allowance 16384; serialized
request at most 8192 bytes; bounded response at most 32768 bytes. Oversize requests
are rejected, not truncated. Oversize/incomplete responses are discarded, never
repaired or silently retried. A small output cap can constrain a future reasoning
response, but the actual completed 149-token r2 response is not evidence of that.
OpenAI documents incomplete/max_output_tokens as the signal for hitting that cap:
https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning
Local repository has no OpenAI SDK dependency; source was inspected first, then
this official reference. No claim about unverified pricing/model limits is added.

## Prompt/schema burden and justified next change

The fixed request asks for exact, unique, whole-word evidence quotes, explicit
pickup/dropoff roles, retained negations, multilingual language/style enums and
version4 strict JSON. It forbids address correction inside evidence, arbitrary
replies, prices, promises, confirmation or execution. Backend handles geocoding,
scheduling, pricing and confirmation. These constraints are intentional, but
literal equality in the fixture oracle was unnecessarily narrower than valid
source evidence. Correct that layer, preserve route/negation/business safety, and
record fixed field-name/boolean mismatch diagnostics. Do not expand the model's
execution authority to make a test pass.

R3 adds bounded response status/incomplete reason/error-present diagnostics,
`transportLatencyMs` (fetch+body only) and `preflightTotalMs` (function entry through
settlement); legacy metrics remain explicitly labelled as above. No text, error
messages, reasoning content, keys or private transcript enters diagnostics. These
changes do not alter the request hash, model, effort, token cap or deadline.

## Quality and speed acceptance framework

User goal: normally a useful text response in <5s with sufficient reasoning.
Treat this as a product target, not a guarantee or a result already achieved.
For an adequately funded future evaluation, operationalize “normally” as at least
90% of eligible text turns under 5s, report p50, p95, maximum, sample count and
all failures (timeouts must not disappear from latency reporting). Report model
turns separately from deterministic consent/number/handoff turns so cheap menu
steps cannot conceal slow understanding. With few samples, report each value
and explicitly decline percentile or reliability claims.

Measure customer-facing useful completion from accepted inbound webhook to
Twilio acceptance of the complete useful response. Separately record provider
roundtrip, state/validation/queue duration, send duration, and delivery callback
latency when available. Twilio acceptance is not proof of handset display. A fast
empty acknowledgement does not meet the useful-reply target. Error/pause notices
are failures for task completion even when fast. No private transcript collection
is implied; use synthetic fixtures, per-stage numeric timings and fixed outcomes.

Quality gates precede speed: explicit consent; correct supported fields retained;
no invented or swapped address roles, lost negation or date assumption; ask only
missing/ambiguous details; numbered selection and clear written equivalents;
user correction and final confirmation; deterministic quote and no execution
from model output. Require all safety cases pass and report extraction/completion
rates per scenario. A single pinned preflight plus one handset model turn is a
smoke test only, insufficient to certify broad dialogue quality or p95 latency.

Offline options, in preferred order:

1. Keep consent, menu selection, known acknowledgements and handoff deterministic.
   Existing code already avoids model calls for those paths.
2. Evaluate a shorter task-specific prompt/schema and compact current state with
   identical safety fixtures before proposing a changed paid request. Do not
   strip source evidence, ambiguity or correction context. Request bytes and
   actual token usage must both be measured; bytes alone are not billed tokens.
3. Separate durable webhook acceptance from long model/send work if later traces
   show webhook deadlines cause failure. Maintain one durable event/reservation,
   cancellation on stop/expiry and no extra reply/retry; async architecture does
   not by itself make the customer's useful reply faster.
4. Only parallelize independent read-only work if useful. Evidence extraction,
   address validation, authoritative quote and confirmation have dependencies;
   do not run speculative billable calls or concurrent same-conversation writes.
5. Evaluate effort/token headroom only after status/usage show a bottleneck and a
   separate bounded comparison is approved. No `none` configuration. More effort
   may improve some cases and cost time; no unmeasured advantage is promised.

Voice remains OFF. A future voice test starts timing when the complete media is
available to the webhook, then measures authenticated download, transcription,
reasoning/validation and send independently; report clip duration/bytes and
quality of retained instructions. Unclear transcription requires confirmation.
Text and voice can share the validated draft pipeline; a transcription model
followed by Sol reasoning is a routing concept, not an approved model change or
paid call. Multiple reasoning models or premium tiers are not yet justified by
measurements. Provider variability prevents a hard universal <5s guarantee.
