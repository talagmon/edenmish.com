import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, '../migrations/020_business_wallet_schema_repair.sql'),
  'utf8',
);
const workflow = readFileSync(
  resolve(here, '../../.github/workflows/staging-worker.yml'),
  'utf8',
);

const walletTables = [
  'business_users',
  'business_accounts',
  'business_members',
  'business_auth_challenges',
  'business_sessions',
  'business_wallets',
  'wallet_topups',
  'wallet_credit_lots',
  'wallet_reservations',
  'wallet_entries',
  'business_plan_enrollments',
];

test('wallet repair is additive and idempotent for every required table', () => {
  assert.doesNotMatch(migration, /ALTER\s+TABLE/i);
  for (const table of walletTables) {
    assert.match(
      migration,
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i'),
    );
  }
  assert.doesNotMatch(migration, /CREATE\s+INDEX(?!\s+IF\s+NOT\s+EXISTS)/i);
});

test('staging applies the repair before wallet readiness verification', () => {
  const applyIndex = workflow.indexOf('020_business_wallet_schema_repair.sql');
  const verifyIndex = workflow.indexOf('Verify remote business wallet schema readiness');
  assert.ok(applyIndex >= 0, 'staging workflow must apply migration 020');
  assert.ok(verifyIndex > applyIndex, 'repair must run before the readiness gate');
});
