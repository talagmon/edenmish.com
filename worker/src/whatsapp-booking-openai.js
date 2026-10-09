import { continuationSelected, continuationCanProceed, reserveContinuation, finishContinuation } from './whatsapp-continuation.js';
import { createBookingModel, validateBookingProposal } from './whatsapp-booking-model.js';
import { lunaPilot, lunaPilotCanRun, reserveLunaPilotModel, finishLunaPilotModel,
  LUNA_PILOT_LIMITS, LUNA_READINESS_LIMITS, lunaUsageUpperMicros } from './whatsapp-pilot-budget.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE_BYTES = 32768;
const failure = category => Object.assign(new Error('Booking interpretation failed'), { category });
async function boundedJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); throw failure('response_size');
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('response_size'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw failure('response_json'); }
  } finally { reader.releaseLock(); }
}
export function bookingModelEnvelope(result) {
  if (result?.status !== 'completed' || result.error || result.incomplete_details
    || !Array.isArray(result.output) || result.output.length < 1 || result.output.length > 2
    || result.output.some(item => !['message','reasoning'].includes(item?.type))
    || result.output.filter(item => item.type === 'reasoning').length > 1) throw failure('response_envelope');
  const messages = result.output.filter(item => item.type === 'message');
  if (messages.length !== 1) throw failure('response_envelope');
  const message = messages[0];
  if (message.role !== 'assistant' || message.status !== 'completed'
    || !Array.isArray(message.content) || message.content.length !== 1) throw failure('response_envelope');
  const content = message.content[0];
  if (content.type === 'refusal') throw failure('refusal');
  if (content.type !== 'output_text' || typeof content.text !== 'string' || content.text.length > 8000) throw failure('response_envelope');
  // Reasoning items, when present, are ignored: never logged or used as a reply.
  return content.text;
}

// No generic key, arbitrary model/endpoint, history, tools or retry fallback.
// Readiness is an internal-only capability: explicit OFF-state approval and
// expiry are required; no customer webhook can set this option.
export function createOpenAIBookingModel(env, { fetchImpl = globalThis.fetch, readiness = false,
  clock = Date.now, onDiagnostic = () => {}, readinessCase = null, acceptProposal = () => true, eventId = null } = {}) {
  const pilot = lunaPilot(env);
  const continuation = continuationSelected(env);
  if (continuation && (readiness || !pilot || !/^[a-f0-9]{64}$/.test(eventId || ''))) return undefined;
  const countedMode = readiness || continuation;
  const canProceed = () => continuation ? continuationCanProceed(env,clock()) : lunaPilotCanRun(env,clock(),readiness);
  if (readiness && (!readinessCase || !pilot || !lunaPilotCanRun(env, clock(), true))) return undefined;
  const config = readiness ? { ...env, WHATSAPP_BOOKING_MODEL_ENABLED: 'on', WHATSAPP_BOOKING_MODEL_EVAL_APPROVED: 'on' } : env;
  if (['WHATSAPP_BOOKING_MODEL_ENABLED', 'WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED',
    'WHATSAPP_BOOKING_MODEL_EVAL_APPROVED', 'WHATSAPP_BOOKING_MODEL_SPEND_APPROVED']
    .some(flag => config[flag] !== 'on')
    || config.WHATSAPP_BOOKING_MODEL !== 'gpt-6-luna'
    || !/^sk-[A-Za-z0-9_-]{12,}$/.test(config.WHATSAPP_BOOKING_OPENAI_API_KEY || '')) return undefined;
  const key = config.WHATSAPP_BOOKING_OPENAI_API_KEY;
  return createBookingModel(async (request, { signal }) => {
    let countedInput = null;
    const syntheticDiagnostic = readiness ? { response_status: null, provider_error_code: null,
      counted_input_tokens: null, output_tokens: null, schema_valid: false, output_structure: null, incomplete_reason: null, synthetic_output: null } : null;
    let attempt = null, result = null, outcome = 'transport_failure', httpStatus = null;
    const started = clock();
    try {
      if (signal.aborted) throw failure('timeout');
      const input = { customer_message: request.customer_message,
        context: request.context, approved_facts: request.approved_facts };
      const payload = { model: 'gpt-6-luna', store: false, service_tier: 'default',
        reasoning: { effort: 'none' }, max_output_tokens: countedMode ? LUNA_READINESS_LIMITS.outputTokens : 1024,
        instructions: request.instructions,
        input: [{ role: 'user', content: JSON.stringify(input) }],
        text: { format: { type: 'json_schema', name: 'booking_proposal', strict: true, schema: request.schema } },
      };
      const body = JSON.stringify(payload);
      if (new TextEncoder().encode(body).byteLength > (countedMode ? LUNA_READINESS_LIMITS.requestBytes : 16000)) throw failure('response_size');
      if (pilot) {
        attempt = continuation ? await reserveContinuation(env,'model',eventId,clock()) : await reserveLunaPilotModel(env, clock(), readiness, readinessCase);
        if (!attempt) { outcome = 'pilot_limit'; return null; }
        // Check fresh time AFTER awaited reservation, immediately before IO.
        if (!await canProceed()) throw failure('expired');
      }
      if (signal.aborted) throw failure('timeout');
      if (countedMode) {
        // Count the identical model input, including schema and formatting, before
        // generation. No byte-to-token estimate, history, tools or hidden context.
        const countBody = JSON.stringify({ model: payload.model, instructions: payload.instructions,
          input: payload.input, reasoning: payload.reasoning, text: payload.text });
        // Workers supports manual/follow, not redirect:error. Manual plus the
        // !ok check rejects redirects without forwarding credentials elsewhere.
        const counted = await fetchImpl(`${ENDPOINT}/input_tokens`, { method: 'POST', redirect: 'manual', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: countBody });
        httpStatus = counted.status;
        if (!counted.ok) { await counted.body?.cancel(); throw failure('input_token_count'); }
        const count = await boundedJson(counted);
        if (count?.object !== 'response.input_tokens' || !Number.isSafeInteger(count.input_tokens)
          || count.input_tokens < 1) throw failure('input_token_count');
        if (count.input_tokens > LUNA_READINESS_LIMITS.inputTokens) throw failure('input_limit');
        countedInput = count.input_tokens;
        if (syntheticDiagnostic) syntheticDiagnostic.counted_input_tokens = countedInput;
        if (signal.aborted) throw failure('timeout');
        if (!await canProceed()) throw failure('expired');
      }
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
      httpStatus = response.status;
      if (!response.ok) {
        if (readiness) {
          try {
            const failed = await boundedJson(response);
            const code = failed?.error?.code;
            if (['invalid_api_key','insufficient_quota','model_not_found','rate_limit_exceeded',
              'invalid_json_schema','unsupported_value','context_length_exceeded'].includes(code)) syntheticDiagnostic.provider_error_code = code;
          } catch { /* Never retain provider error text, headers or credentials. */ }
        } else await response.body?.cancel();
        throw failure('http_error');
      }
      result = await boundedJson(response);
      if (readiness) {
        syntheticDiagnostic.response_status = ['completed','incomplete','failed','cancelled'].includes(result.status) ? result.status : 'other';
        syntheticDiagnostic.output_tokens = Number.isSafeInteger(result.usage?.output_tokens) ? result.usage.output_tokens : null;
        syntheticDiagnostic.incomplete_reason = ['max_output_tokens','content_filter'].includes(result.incomplete_details?.reason) ? result.incomplete_details.reason : null;
        syntheticDiagnostic.output_structure = Array.isArray(result.output) ? result.output.slice(0,4).map(item => ({
          type: ['message','reasoning','function_call'].includes(item?.type) ? item.type : 'other',
          status: ['completed','incomplete','in_progress'].includes(item?.status) ? item.status : 'absent_or_other',
          content_types: Array.isArray(item?.content) ? item.content.slice(0,3).map(c=>['output_text','refusal'].includes(c?.type)?c.type:'other') : []
        })) : null;
        const texts = Array.isArray(result.output) ? result.output.filter(i=>i?.type==='message' && i.role==='assistant')
          .flatMap(i=>Array.isArray(i.content)?i.content:[]).filter(c=>c?.type==='output_text' && typeof c.text==='string') : [];
        if (texts.length===1 && texts[0].text.length<=8000) syntheticDiagnostic.synthetic_output=texts[0].text;
      }
      if (signal.aborted) throw failure('timeout');
      if (pilot && !await canProceed()) throw failure('expired');
      if (pilot && (result.model !== 'gpt-6-luna' || result.service_tier !== 'default' || lunaUsageUpperMicros(result.usage) === null)) throw failure('usage_unverified');
      if (countedMode && (result.usage.input_tokens !== countedInput || result.usage.output_tokens > LUNA_READINESS_LIMITS.outputTokens)) throw failure('usage_unverified');
      const content = bookingModelEnvelope(result);
      if (readiness) syntheticDiagnostic.synthetic_output = content;
      let raw;
      try { raw = JSON.parse(content); } catch { throw failure('proposal_json'); }
      const proposal = validateBookingProposal(raw, request.customer_message, clock());
      if (!proposal) throw failure('proposal_schema');
      if (readiness) syntheticDiagnostic.schema_valid = true;
      if (readiness && !acceptProposal(proposal)) throw failure('readiness_mismatch');
      outcome = 'valid_proposal';
      if (continuation && attempt) {
        await finishContinuation(env,'model',eventId,{ok:true,usage:result.usage},clock());
        if (!await canProceed()) return null;
      }
      else if (attempt) await finishLunaPilotModel(env, attempt, { outcome, httpStatus, usage: result.usage, elapsedMs: Math.max(0, clock()-started) }, clock());
      return content;
    } catch (error) {
      outcome = signal.aborted ? 'timeout' : ['http_error','response_size','response_json','response_envelope','refusal',
        'proposal_json','proposal_schema','usage_unverified','expired','readiness_mismatch','input_token_count','input_limit'].includes(error?.category) ? error.category : 'transport_failure';
      if (attempt) {
        try { if (continuation) await finishContinuation(env,'model',eventId,{ok:false},clock());
          else await finishLunaPilotModel(env, attempt, { outcome, httpStatus, elapsedMs: Math.max(0, clock()-started) }, clock()); }
        catch { /* An unpersisted settlement retains the pending reservation. */ }
      }
      return null;
    } finally {
      // Customer diagnostics are fixed categories/numbers only. Authenticated fixed
      // synthetic probes may return their bounded answer; never headers/error text.
      try { onDiagnostic({ outcome, httpStatus, elapsedMs: Math.max(0, clock()-started), ...(readiness ? { synthetic: syntheticDiagnostic } : {}) }); } catch { /* Diagnostic only. */ }
    }
  }, { timeoutMs: pilot ? LUNA_PILOT_LIMITS.timeoutMs : 1500 });
}
