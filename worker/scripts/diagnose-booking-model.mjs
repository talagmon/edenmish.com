import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEvaluationBudget } from './booking-eval-budget.mjs';
import { runSingleDiagnosticEvaluation } from './evaluate-booking-model.mjs';

// One narrowly authorized continuation. Accept only the exact original ledger
// state: one uncertain reservation, no settlement. Never reset or edit that file.
export function readOriginalReservation(path) {
  const source = readFileSync(path, 'utf8');
  if (source.length > 1000) throw new Error('Prior approval ledger changed.');
  const rows = source.trim().split('\n').map(JSON.parse);
  const expected = [
    { type: 'start', model: 'gpt-6-luna', budgetMicros: 1_000_000, maxRequests: 30, pricingDate: '2026-10-08' },
    { type: 'reserve', sequence: 1, micros: 300_000 },
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) throw new Error('Prior approval ledger changed.');
  return { requests: 1, reservedMicros: 300_000, remainingMicros: 700_000 };
}

export async function runApprovedDiagnostic({ key, priorLedgerPath, ledgerPath, fetchImpl = globalThis.fetch }) {
  if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key || '')) throw new Error('Dedicated credential required.');
  const prior = readOriginalReservation(priorLedgerPath);
  // New ledger is exclusively created: this continuation can never restart.
  // Its budget is the remainder, not another dollar. Only ONE new request.
  const budget = createEvaluationBudget({ ledgerPath, budgetMicros: prior.remainingMicros, maxRequests: 1, fetchImpl });
  try {
    const report = await runSingleDiagnosticEvaluation({ key, budget });
    return { ...report, diagnosticTimeoutMs: 10_000, productionTimeoutMs: 1500,
      cumulative: { requests: prior.requests + report.budget.requests,
        reservedOrUpperCostMicros: prior.reservedMicros + report.budget.chargedMicros,
        remainingMicros: report.budget.remainingMicros, priorUncertainReservationMicros: prior.reservedMicros } };
  } finally { budget.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const out = new URL('../../outputs/', import.meta.url);
  const permitted = process.argv.length === 3 && process.argv[2] === '--approved-one-diagnostic'
    && new Date().toISOString().slice(0, 10) === '2026-10-08';
  if (!permitted) { console.error('Explicit one-request approval and current tariff review required.'); process.exitCode = 1; }
  else runApprovedDiagnostic({ key: process.env.WHATSAPP_BOOKING_OPENAI_API_KEY,
    priorLedgerPath: new URL('approved-synthetic-evaluation-2026-10-08.jsonl', out),
    ledgerPath: fileURLToPath(new URL('approved-single-diagnostic-2026-10-08.jsonl', out)),
  }).then(report => console.log(JSON.stringify(report))).catch(() => {
    console.error('Diagnostic stopped or refused. Inspect sanitized records; no automatic retry.'); process.exitCode = 1;
  });
}
