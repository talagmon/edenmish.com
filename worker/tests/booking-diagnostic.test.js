import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprovedDiagnostic, readOriginalReservation } from '../scripts/diagnose-booking-model.mjs';

const original = '{"type":"start","model":"gpt-6-luna","budgetMicros":1000000,"maxRequests":30,"pricingDate":"2026-10-08"}\n{"type":"reserve","sequence":1,"micros":300000}\n';
const corpus = JSON.parse(readFileSync(new URL('./fixtures/whatsapp-booking-model-evals.json', import.meta.url)));
const item = corpus.find(x => x.id === 'compact_request');
const proposal = { version: 2, intent: item.intent, topic: null, clarify_field: null,
  fields: Object.entries(item.fields).map(([field, value]) => ({ field, quote: value })) };
const goodResponse = () => Response.json({ model: 'gpt-6-luna', service_tier: 'default',
  usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }, status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] });
async function withFiles(run) {
  const dir = mkdtempSync(join(tmpdir(), 'booking-diagnostic-'));
  const paths = { priorLedgerPath: join(dir, 'prior.jsonl'), ledgerPath: join(dir, 'diagnostic.jsonl') };
  writeFileSync(paths.priorLedgerPath, original);
  try { await run(paths); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('one diagnostic preserves prior reservation, accepts a result after 1.5 seconds, and cannot restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withFiles(async paths => {
    let calls = 0; let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const options = { ...paths, key: 'sk-synthetic-test-only', fetchImpl: async () => {
      calls++; started(); return new Promise(resolve => setTimeout(() => resolve(goodResponse()), 2000));
    } };
    const pending = runApprovedDiagnostic(options);
    await waiting; t.mock.timers.tick(2000);
    const report = await pending;
    assert.equal(calls, 1); assert.equal(report.results.length, 1);
    assert.equal(report.results[0].outcome, 'match');
    assert.equal(report.diagnosticTimeoutMs, 10_000); assert.equal(report.productionTimeoutMs, 1500);
    assert.equal(report.cumulative.requests, 2);
    assert.equal(report.cumulative.priorUncertainReservationMicros, 300_000);
    assert.equal(report.cumulative.reservedOrUpperCostMicros, 300_000 + report.budget.chargedMicros);
    assert.equal(report.cumulative.remainingMicros, 1_000_000 - report.cumulative.reservedOrUpperCostMicros);
    assert.equal(readFileSync(paths.priorLedgerPath, 'utf8'), original);
    await assert.rejects(runApprovedDiagnostic(options), /EEXIST/); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(report) + readFileSync(paths.ledgerPath, 'utf8'), /sk-|Bearer|דיזנגוף/);
  });
});

test('10-second diagnostic abort retains both reservations and never retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withFiles(async paths => {
    let calls = 0; let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const pending = runApprovedDiagnostic({ ...paths, key: 'sk-synthetic-test-only', fetchImpl: async (_url, { signal }) => {
      calls++; started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private')), { once: true }));
    } });
    await waiting; t.mock.timers.tick(10_000);
    const report = await pending;
    assert.equal(calls, 1); assert.equal(report.results[0].outcome, 'fallback');
    assert.equal(report.budget.failure.reason, 'request_aborted');
    assert.equal(report.cumulative.requests, 2);
    assert.equal(report.cumulative.reservedOrUpperCostMicros, 600_000);
    assert.equal(report.cumulative.remainingMicros, 400_000);
  });
});

test('missing, changed, settled or exhausted prior ledger refuses before a new ledger or request', async () => {
  await withFiles(async paths => {
    for (const source of ['', original.replace('300000', '900000'), original + '{"type":"settle"}\n', original.replace('"sequence":1', '"sequence":30')]) {
      writeFileSync(paths.priorLedgerPath, source);
      assert.throws(() => readOriginalReservation(paths.priorLedgerPath));
      await assert.rejects(runApprovedDiagnostic({ ...paths, key: 'sk-synthetic-test-only', fetchImpl: () => { assert.fail('network forbidden'); } }));
      assert.equal(existsSync(paths.ledgerPath), false);
    }
  });
});
