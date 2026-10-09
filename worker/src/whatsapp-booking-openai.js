import { createBookingModel, validateBookingProposal } from './whatsapp-booking-model.js';
import { lunaPilot, lunaPilotCanRun, reserveLunaPilotModel, finishLunaPilotModel,
  LUNA_PILOT_LIMITS, lunaUsageUpperMicros } from './whatsapp-pilot-budget.js';

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
  clock = Date.now, onDiagnostic = () => {}, readinessCase = null, acceptProposal = () => true } = {}) {
  const pilot = lunaPilot(env);
  if (readiness && (!pilot || !lunaPilotCanRun(env, clock(), true))) return undefined;
  const config = readiness ? { ...env, WHATSAPP_BOOKING_MODEL_ENABLED: 'on', WHATSAPP_BOOKING_MODEL_EVAL_APPROVED: 'on' } : env;
  if (['WHATSAPP_BOOKING_MODEL_ENABLED', 'WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED',
    'WHATSAPP_BOOKING_MODEL_EVAL_APPROVED', 'WHATSAPP_BOOKING_MODEL_SPEND_APPROVED']
    .some(flag => config[flag] !== 'on')
    || config.WHATSAPP_BOOKING_MODEL !== 'gpt-6-luna'
    || !/^sk-[A-Za-z0-9_-]{12,}$/.test(config.WHATSAPP_BOOKING_OPENAI_API_KEY || '')) return undefined;
  const key = config.WHATSAPP_BOOKING_OPENAI_API_KEY;
  return createBookingModel(async (request, { signal }) => {
    let attempt = null, result = null, outcome = 'transport_failure', httpStatus = null;
    const started = clock();
    try {
      if (signal.aborted) throw failure('timeout');
      const input = { customer_message: request.customer_message,
        context: request.context, approved_facts: request.approved_facts };
      const body = JSON.stringify({ model: 'gpt-6-luna', store: false, service_tier: 'default',
        reasoning: { effort: 'none' }, max_output_tokens: 1024,
        instructions: request.instructions,
        input: [{ role: 'user', content: JSON.stringify(input) }],
        text: { format: { type: 'json_schema', name: 'booking_proposal', strict: true, schema: request.schema } },
      });
      if (new TextEncoder().encode(body).byteLength > 16000) throw failure('response_size');
      if (pilot) {
        attempt = await reserveLunaPilotModel(env, clock(), readiness, readinessCase);
        if (!attempt) { outcome = 'pilot_limit'; return null; }
        // Check fresh time AFTER awaited reservation, immediately before IO.
        if (!lunaPilotCanRun(env, clock(), readiness)) throw failure('expired');
      }
      if (signal.aborted) throw failure('timeout');
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
      httpStatus = response.status;
      if (!response.ok) { await response.body?.cancel(); throw failure('http_error'); }
      result = await boundedJson(response);
      if (signal.aborted) throw failure('timeout');
      if (pilot && !lunaPilotCanRun(env, clock(), readiness)) throw failure('expired');
      if (pilot && (result.model !== 'gpt-6-luna' || result.service_tier !== 'default' || lunaUsageUpperMicros(result.usage) === null)) throw failure('usage_unverified');
      const content = bookingModelEnvelope(result);
      let raw;
      try { raw = JSON.parse(content); } catch { throw failure('proposal_json'); }
      const proposal = validateBookingProposal(raw, request.customer_message, clock());
      if (!proposal) throw failure('proposal_schema');
      if (readiness && !acceptProposal(proposal)) throw failure('readiness_mismatch');
      outcome = 'valid_proposal';
      if (attempt) await finishLunaPilotModel(env, attempt, { outcome, httpStatus, usage: result.usage, elapsedMs: Math.max(0, clock()-started) }, clock());
      return content;
    } catch (error) {
      outcome = signal.aborted ? 'timeout' : ['http_error','response_size','response_json','response_envelope','refusal',
        'proposal_json','proposal_schema','usage_unverified','expired','readiness_mismatch'].includes(error?.category) ? error.category : 'transport_failure';
      if (attempt) {
        try { await finishLunaPilotModel(env, attempt, { outcome, httpStatus, elapsedMs: Math.max(0, clock()-started) }, clock()); }
        catch { /* An unpersisted settlement retains the pending reservation. */ }
      }
      return null;
    } finally {
      // Only fixed categories and numeric metadata; no provider/user text or IDs.
      try { onDiagnostic({ outcome, httpStatus, elapsedMs: Math.max(0, clock()-started) }); } catch { /* Diagnostic only. */ }
    }
  }, { timeoutMs: pilot ? LUNA_PILOT_LIMITS.timeoutMs : 1500 });
}
