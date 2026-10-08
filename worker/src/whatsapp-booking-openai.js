import { createBookingModel } from './whatsapp-booking-model.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE_BYTES = 32768;

async function boundedJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}

// Called only by the enabled booking service factory. Do not fall back to generic
// OPENAI_API_KEY, process.env, arbitrary models/endpoints or another provider.
export function createOpenAIBookingModel(env, { fetchImpl = globalThis.fetch } = {}) {
  if (['WHATSAPP_BOOKING_MODEL_ENABLED', 'WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED',
    'WHATSAPP_BOOKING_MODEL_EVAL_APPROVED', 'WHATSAPP_BOOKING_MODEL_SPEND_APPROVED']
    .some(flag => env[flag] !== 'on')
    || env.WHATSAPP_BOOKING_MODEL !== 'gpt-6-luna'
    || !/^sk-[A-Za-z0-9_-]{12,}$/.test(env.WHATSAPP_BOOKING_OPENAI_API_KEY || '')) return undefined;
  const key = env.WHATSAPP_BOOKING_OPENAI_API_KEY;
  return createBookingModel(async (request, { signal }) => {
    if (signal.aborted) return null;
    // Explicit projection prevents accidental future context/history additions.
    const input = { customer_message: request.customer_message,
      context: request.context, approved_facts: request.approved_facts };
    const body = JSON.stringify({ model: 'gpt-6-luna', store: false,
      reasoning: { effort: 'none' }, max_output_tokens: 1024,
      instructions: request.instructions,
      input: [{ role: 'user', content: JSON.stringify(input) }],
      text: { format: { type: 'json_schema', name: 'booking_proposal', strict: true, schema: request.schema } },
    });
    if (body.length > 16000) return null;
    const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const result = await boundedJson(response);
    if (signal.aborted || result?.status !== 'completed' || result.error || result.incomplete_details
      || !Array.isArray(result.output) || result.output.length !== 1) return null;
    const message = result.output[0];
    if (message.type !== 'message' || message.role !== 'assistant' || message.status !== 'completed'
      || !Array.isArray(message.content) || message.content.length !== 1) return null;
    const content = message.content[0];
    return content.type === 'output_text' && typeof content.text === 'string' && content.text.length <= 8000
      ? content.text : null;
  });
}
