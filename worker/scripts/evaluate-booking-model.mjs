import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenAIBookingModel } from '../src/whatsapp-booking-openai.js';
import { proposeBookingTurn, validateBookingProposal } from '../src/whatsapp-booking-model.js';
import { createEvaluationBudget, EVAL_LIMITS } from './booking-eval-budget.mjs';

// Fixed checked-in synthetic corpus only: no file/input/customer-data argument.
const corpus = JSON.parse(readFileSync(new URL('../tests/fixtures/whatsapp-booking-model-evals.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-10-08T08:00:00Z');
const cases = corpus.filter(item => !item.control);
const comparable = proposal => JSON.stringify({ ...proposal, entries: [...proposal.entries].sort(([a], [b]) => a.localeCompare(b)) });
export const evaluationPlan = () => ({ mode: 'dry-run', model: 'gpt-6-luna', cases: cases.map(item => item.id),
  maxRequests: EVAL_LIMITS.requests, maxBudgetUsd: 1, reservationPerRequestUsd: 0.30, networkCalls: 0 });

function expectedProposal(item) {
  if (item.invalid) return null; // adversarial cases need human semantic review
  const raw = { version: 1, intent: item.intent, topic: item.topic || null, clarify_field: item.clarify_field || null,
    fields: Object.entries(item.fields || {}).map(([field, value]) => ({ field, start: item.text.indexOf(value), end: item.text.indexOf(value) + value.length })) };
  return validateBookingProposal(raw, item.text, now);
}

async function runCases({ key, budget, onResult = () => {} }, diagnostic = false) {
  if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key || '')) throw new Error('Dedicated evaluation credential required.');
  const adapter = createOpenAIBookingModel({ WHATSAPP_BOOKING_MODEL_ENABLED: 'on', WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED: 'on',
    WHATSAPP_BOOKING_MODEL_EVAL_APPROVED: 'on', WHATSAPP_BOOKING_MODEL_SPEND_APPROVED: 'on',
    WHATSAPP_BOOKING_MODEL: 'gpt-6-luna', WHATSAPP_BOOKING_OPENAI_API_KEY: key }, { fetchImpl: budget.fetch });
  // This copy exists only in the explicit one-case diagnostic entry point.
  // The Worker adapter remains frozen at its normal 1,500 ms deadline.
  const evaluationAdapter = diagnostic ? Object.freeze({ ...adapter, timeoutMs: 10_000 }) : adapter;
  const results = [];
  for (const item of diagnostic ? cases.slice(0, 1) : cases) {
    if (budget.snapshot().stopped || budget.snapshot().busy) break;
    const started = performance.now();
    const proposal = await proposeBookingTurn(evaluationAdapter, { phase: item.reviewed ? 'review' : 'collect', consent_at: 1, data: {}, language: 'he' }, item.text, now);
    const expected = expectedProposal(item);
    const outcome = !proposal ? 'fallback' : !expected ? 'human_review' : comparable(proposal) === comparable(expected) ? 'match' : 'mismatch';
    const result = { id: item.id, outcome, latencyMs: Math.round(performance.now() - started) };
    results.push(result); onResult(result);
  }
  return { results, budget: budget.snapshot(), qualityApproved: false };
}

export const runSyntheticEvaluation = options => runCases(options);
export const runSingleDiagnosticEvaluation = options => runCases(options, true);

export async function evaluationMain(args, env, log = console.log) {
  if (!args.length || (args.length === 1 && args[0] === '--dry-run')) { log(JSON.stringify(evaluationPlan())); return; }
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--execute-approved-synthetic', '--budget-usd', '--ledger', '--pricing-reviewed-on'].includes(args[i])
      || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid evaluation arguments.');
    flags.set(args[i], args[i + 1]);
  }
  const amount = flags.get('--budget-usd');
  if (flags.size !== 4 || flags.get('--execute-approved-synthetic') !== 'yes'
    || !/^(?:0\.[0-9]{1,2}|1(?:\.0{1,2})?)$/.test(amount || '')
    || flags.get('--pricing-reviewed-on') !== new Date().toISOString().slice(0, 10)) throw new Error('Explicit synthetic-run approval, same-day tariff review, ledger and budget up to $1 required.');
  const key = env.WHATSAPP_BOOKING_OPENAI_API_KEY;
  if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key || '')) throw new Error('Dedicated evaluation credential required.');
  const budget = createEvaluationBudget({ ledgerPath: flags.get('--ledger'), budgetMicros: Math.round(Number(amount) * 1_000_000), fetchImpl: globalThis.fetch });
  try {
    const report = await runSyntheticEvaluation({ key, budget }); log(JSON.stringify(report));
    if (report.budget.stopped || report.budget.busy) throw new Error('Evaluation stopped before completing the corpus.');
  }
  finally { budget.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  evaluationMain(process.argv.slice(2), process.env).catch(() => {
    console.error('Synthetic evaluation failed or refused. Inspect the sanitized ledger; no automatic retry is allowed.'); process.exitCode = 1;
  });
}
