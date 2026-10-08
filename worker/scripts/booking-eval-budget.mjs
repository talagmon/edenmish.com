import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export const EVAL_LIMITS = Object.freeze({ requests: 30, budgetMicros: 1_000_000,
  reserveMicros: 300_000, inputTokens: 1_050_000, outputTokens: 1024,
  requestBytes: 48_000, responseBytes: 32_768, pricingDate: '2026-10-08' });

// Upper-bound tariff: cache-write input ($.125/M), long-context multiplier 2,
// output $.50/M with multiplier 1.5, plus 10% regional premium. Always charge
// all input at the higher tariff, even when cached/short. Integer microdollars.
export function usageUpperCost(usage) {
  const input = usage?.input_tokens; const output = usage?.output_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || input > EVAL_LIMITS.inputTokens
    || !Number.isSafeInteger(output) || output < 0 || output > EVAL_LIMITS.outputTokens
    || usage.total_tokens !== input + output) return null;
  return Math.ceil((input + output * 3) * 11 / 40);
}

// Exclusive creation prevents concurrent runs or restarting the same approval
// ledger with a reset budget. Every reservation is fsynced BEFORE network IO.
// A crashed/uncertain request keeps its full reservation. No auto-resume/refund.
export function createEvaluationBudget({ ledgerPath, budgetMicros, maxRequests = 30, fetchImpl }) {
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 1 || budgetMicros > EVAL_LIMITS.budgetMicros
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > EVAL_LIMITS.requests
    || typeof fetchImpl !== 'function') throw new Error('Invalid evaluation limits.');
  const fd = openSync(ledgerPath, 'wx', 0o600);
  let charged = 0; let requests = 0; let busy = false; let stopped = null; let closed = false;
  const record = entry => { writeFileSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd); };
  try {
    record({ type: 'start', model: 'gpt-6-luna', budgetMicros, maxRequests, pricingDate: EVAL_LIMITS.pricingDate });
    const directory = openSync(dirname(ledgerPath), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  catch (error) { closeSync(fd); throw error; }
  const snapshot = () => ({ requests, chargedMicros: charged, remainingMicros: budgetMicros - charged, busy, stopped });
  const refuse = reason => { stopped ||= reason; throw new Error('Synthetic evaluation stopped.'); };
  return {
    snapshot,
    close() { if (!closed) { closed = true; closeSync(fd); } },
    async fetch(url, init) {
      if (closed || stopped || busy) return refuse('run_unavailable');
      if (requests >= maxRequests) return refuse('request_limit');
      if (charged + EVAL_LIMITS.reserveMicros > budgetMicros) return refuse('budget_limit');
      let body;
      try { body = JSON.parse(init.body); } catch { return refuse('invalid_request'); }
      if (url !== 'https://api.openai.com/v1/responses' || init.method !== 'POST' || init.redirect !== 'error'
        || !init.signal || init.signal.aborted || Buffer.byteLength(init.body) > EVAL_LIMITS.requestBytes
        || body.model !== 'gpt-6-luna' || body.store !== false || body.reasoning?.effort !== 'none'
        || body.max_output_tokens !== EVAL_LIMITS.outputTokens
        || Object.keys(body).some(key => !['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text'].includes(key))) return refuse('invalid_request');
      busy = true;
      try {
        const sequence = requests + 1;
        record({ type: 'reserve', sequence, micros: EVAL_LIMITS.reserveMicros });
        requests = sequence; charged += EVAL_LIMITS.reserveMicros;
        // Pin Standard instead of an account's automatic priority/fast setting.
        const response = await fetchImpl(url, { ...init, body: JSON.stringify({ ...body, service_tier: 'default' }) });
        if (!response.ok || !response.body || init.signal.aborted) {
          await response.body?.cancel(); return refuse('provider_failure');
        }
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > EVAL_LIMITS.responseBytes || init.signal.aborted) { await reader.cancel(); return refuse('response_limit'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        const bytes = Buffer.concat(chunks); let result;
        try { result = JSON.parse(bytes.toString('utf8')); } catch { return refuse('invalid_response'); }
        const cost = usageUpperCost(result.usage);
        if (closed || init.signal.aborted || result.model !== 'gpt-6-luna' || result.service_tier !== 'default'
          || cost === null || cost > EVAL_LIMITS.reserveMicros) return refuse('usage_unverified');
        record({ type: 'settle', sequence, micros: cost, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens });
        charged -= EVAL_LIMITS.reserveMicros - cost;
        return new Response(bytes, { status: response.status, headers: { 'Content-Type': 'application/json' } });
      } catch {
        // Never copy provider errors, headers, responses or credentials to logs.
        stopped ||= 'transport_or_ledger_failure';
        throw new Error('Synthetic evaluation stopped.');
      } finally { busy = false; }
    },
  };
}
