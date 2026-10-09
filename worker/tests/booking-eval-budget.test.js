import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluationBudget, usageUpperCost, EVAL_LIMITS } from '../scripts/booking-eval-budget.mjs';
import { evaluationMain, runSyntheticEvaluation } from '../scripts/evaluate-booking-model.mjs';

const endpoint = 'https://api.openai.com/v1/responses';
const init = () => ({ method: 'POST', redirect: 'manual', signal: new AbortController().signal,
  headers: { Authorization: 'Bearer sk-synthetic-test-only' },
  body: JSON.stringify({ model: 'gpt-6-luna', store: false, reasoning: { effort: 'none' }, max_output_tokens: 1024,
    instructions: 'synthetic', input: [{ role: 'user', content: 'synthetic' }], text: {} }) });
const result = (overrides = {}) => new Response(JSON.stringify({ model: 'gpt-6-luna', service_tier: 'default', usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }, ...overrides }));
async function withBudget(options, run) {
  const dir = mkdtempSync(join(tmpdir(), 'booking-eval-')); const ledgerPath = join(dir, 'ledger.jsonl');
  let budget;
  try { budget = createEvaluationBudget({ ledgerPath, budgetMicros: 1_000_000, ...options }); await run(budget, ledgerPath); }
  finally { budget?.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('durable reservation precedes IO, verified usage settles conservatively and same ledger cannot restart', async () => {
  let calls = 0; let ledgerPath;
  await withBudget({ fetchImpl: async (_url, request) => {
    calls++; assert.equal(JSON.parse(request.body).service_tier, 'default');
    const entries = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.at(-1).type, 'reserve'); return result();
  } }, async (budget, path) => {
    ledgerPath = path;
    assert.throws(() => createEvaluationBudget({ ledgerPath: path, budgetMicros: 1_000_000, fetchImpl: async () => {} }), /EEXIST/);
    await budget.fetch(endpoint, init());
    assert.equal(calls, 1); assert.equal(budget.snapshot().chargedMicros, usageUpperCost({ input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }));
    const entries = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(item => item.type), ['start', 'reserve', 'settle']);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /Bearer|sk-|synthetic|instructions/);
  });
});

test('maximum priced requests exhaust the dollar budget before the request limit', async () => {
  let calls = 0;
  await withBudget({ fetchImpl: async () => { calls++; return result({ usage: { input_tokens: 1050000, output_tokens: 1024, total_tokens: 1051024 } }); } }, async budget => {
    for (let i = 0; i < 3; i++) await budget.fetch(endpoint, init());
    await assert.rejects(budget.fetch(endpoint, init()));
    assert.equal(calls, 3); assert.equal(budget.snapshot().stopped, 'budget_limit');
    assert.ok(budget.snapshot().chargedMicros <= 1_000_000);
  });
});

test('hard request cap cannot be replenished by cheap success and budget below reservation makes no call', async () => {
  let calls = 0;
  await withBudget({ maxRequests: 2, fetchImpl: async () => { calls++; return result(); } }, async budget => {
    await budget.fetch(endpoint, init()); await budget.fetch(endpoint, init());
    await assert.rejects(budget.fetch(endpoint, init())); assert.equal(calls, 2); assert.equal(budget.snapshot().stopped, 'request_limit');
  });
  await withBudget({ budgetMicros: 299999, fetchImpl: async () => { calls++; } }, async budget => {
    await assert.rejects(budget.fetch(endpoint, init())); assert.equal(calls, 2); assert.equal(budget.snapshot().requests, 0);
  });
});

test('unknown/failing/oversized/wrong-tier usage keeps full reservation and stops further calls', async () => {
  for (const factory of [() => { throw new Error('secret provider detail'); }, () => new Response('secret', { status: 429 }),
    () => result({ usage: null }), () => result({ service_tier: 'priority' }), () => result({ model: 'other' }),
    () => result({ usage: { input_tokens: 1000, output_tokens: 5000, total_tokens: 6000 } }),
    () => new Response('x'.repeat(32769)), () => new Response('not-json'),
  ]) {
    let calls = 0;
    await withBudget({ fetchImpl: async () => { calls++; return factory(); } }, async (budget, path) => {
      await assert.rejects(budget.fetch(endpoint, init()), { message: 'Synthetic evaluation stopped.' });
      assert.equal(budget.snapshot().chargedMicros, EVAL_LIMITS.reserveMicros);
      await assert.rejects(budget.fetch(endpoint, init())); assert.equal(calls, 1);
      assert.doesNotMatch(readFileSync(path, 'utf8'), /secret/);
    });
  }
});

test('concurrent attempts cannot race reservations; timeout/abort cannot refund or retry', async () => {
  let release; let calls = 0;
  await withBudget({ fetchImpl: async () => { calls++; return new Promise(resolve => { release = resolve; }); } }, async budget => {
    const first = budget.fetch(endpoint, init());
    await assert.rejects(budget.fetch(endpoint, init())); assert.equal(calls, 1);
    release(result()); await first;
    await assert.rejects(budget.fetch(endpoint, init())); assert.equal(calls, 1);
  });
  await withBudget({ fetchImpl: async (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))) }, async budget => {
    const controller = new AbortController(); const promise = budget.fetch(endpoint, { ...init(), signal: controller.signal }); controller.abort();
    await assert.rejects(promise); assert.equal(budget.snapshot().chargedMicros, EVAL_LIMITS.reserveMicros);
  });
});

test('invalid destinations, payload expansion, limits and malformed usage fail closed', async () => {
  let calls = 0;
  for (const [url, request] of [[endpoint + '/other', init()], [endpoint, { ...init(), body: JSON.stringify({ ...JSON.parse(init().body), tools: [] }) }],
    [endpoint, { ...init(), body: JSON.stringify({ ...JSON.parse(init().body), instructions: 'x'.repeat(48001) }) }]]) {
    await withBudget({ fetchImpl: async () => { calls++; } }, async budget => { await assert.rejects(budget.fetch(url, request)); assert.equal(budget.snapshot().requests, 0); });
  }
  assert.equal(calls, 0);
  for (const usage of [null, { input_tokens: -1, output_tokens: 0, total_tokens: -1 }, { input_tokens: 1, output_tokens: 1, total_tokens: 3 }]) assert.equal(usageUpperCost(usage), null);
  assert.ok(usageUpperCost({ input_tokens: 1050000, output_tokens: 1024, total_tokens: 1051024 }) < EVAL_LIMITS.reserveMicros);
});

test('default CLI is network-free and does not even read credentials; unapproved runs refused', async () => {
  const env = new Proxy({}, { get() { throw new Error('credential read forbidden'); } }); let output;
  await evaluationMain([], env, value => { output = JSON.parse(value); }); assert.equal(output.networkCalls, 0); assert.equal(output.mode, 'dry-run');
  await assert.rejects(evaluationMain(['--execute-approved-synthetic', 'yes'], env));
});

test('fixed corpus runner uses mocked adapter only and reports sanitized results without quality approval', async () => {
  await withBudget({ maxRequests: 1, fetchImpl: async () => result({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ version: 1, intent: 'off_topic', fields: [], topic: null, clarify_field: null }) }] }] }) }, async budget => {
    const report = await runSyntheticEvaluation({ key: 'sk-synthetic-test-only', budget });
    assert.equal(report.budget.requests, 1); assert.equal(report.qualityApproved, false);
    assert.equal(report.results[0].outcome, 'mismatch'); assert.doesNotMatch(JSON.stringify(report), /sk-|customer_message|דיזנגוף/);
  });
});

test('HTTP, transport, invalid JSON and usage failures retain safe distinct evidence without provider text', async () => {
  const cases = [
    ...[400, 401, 403, 404, 429, 500].map(status => ({
      factory: () => new Response('secret-provider-body', { status, headers: { 'x-request-id': 'secret-header' } }),
      reason: 'http_error', phase: 'response', status,
    })),
    { factory: () => { throw new Error('secret-provider-error'); }, reason: 'transport_failure', phase: 'transport', status: null },
    { factory: () => new Response('secret-invalid-json'), reason: 'invalid_response', phase: 'response_json', status: 200 },
    { factory: () => result({ usage: null }), reason: 'usage_unverified', phase: 'usage_verification', status: 200 },
  ];
  for (const item of cases) {
    let calls = 0;
    await withBudget({ fetchImpl: async () => { calls++; return item.factory(); } }, async (budget, path) => {
      await assert.rejects(budget.fetch(endpoint, init()));
      const snapshot = budget.snapshot();
      assert.equal(snapshot.stopped, item.reason);
      assert.equal(snapshot.failure.phase, item.phase);
      assert.equal(snapshot.failure.httpStatus, item.status);
      assert.equal(snapshot.failure.aborted, false);
      assert.ok(Number.isInteger(snapshot.failure.elapsedMs));
      assert.equal(snapshot.chargedMicros, EVAL_LIMITS.reserveMicros);
      await assert.rejects(budget.fetch(endpoint, init()));
      assert.equal(calls, 1);
      const ledger = readFileSync(path, 'utf8');
      assert.doesNotMatch(ledger + JSON.stringify(snapshot), /secret-|Bearer|sk-|Authorization|customer_message/);
      assert.equal(ledger.trim().split('\n').map(JSON.parse).filter(x => x.type === 'failure').length, 1);
      assert.equal(budget.snapshot().failure.reason, item.reason, 'later refusals preserve the original failure');
    });
  }
});

test('configured model deadline records abort before fallback snapshot, with no retry or refund', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  let calls = 0;
  await withBudget({ fetchImpl: async (_url, request) => {
    calls++; requestStarted();
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('private-abort-detail')), { once: true }));
  } }, async (budget, path) => {
    const pending = runSyntheticEvaluation({ key: 'sk-synthetic-test-only', budget });
    await started;
    t.mock.timers.tick(1499);
    assert.equal(budget.snapshot().stopped, null);
    t.mock.timers.tick(1);
    const report = await pending;
    assert.equal(calls, 1);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].outcome, 'fallback');
    assert.equal(report.budget.stopped, 'request_aborted');
    assert.equal(report.budget.failure.aborted, true);
    assert.equal(report.budget.failure.phase, 'transport');
    assert.equal(report.budget.failure.httpStatus, null);
    assert.equal(report.budget.chargedMicros, EVAL_LIMITS.reserveMicros);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /private-abort|sk-|Bearer/);
  });
});
