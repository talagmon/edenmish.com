import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, '../migrations/021_business_entry_plans.sql'), 'utf8');
const schema = readFileSync(resolve(here, '../schema.sql'), 'utf8');
const stagingWorkflow = readFileSync(resolve(here, '../../.github/workflows/staging-worker.yml'), 'utf8');
const productionWorkflow = readFileSync(resolve(here, '../../.github/workflows/production-deploy.yml'), 'utf8');

const constrainedTables = ['business_accounts', 'wallet_topups', 'business_plan_enrollments'];

test('migration 021 expands every persisted plan constraint without losing columns', () => {
  assert.match(migration, /PRAGMA defer_foreign_keys = ON/i);
  assert.match(migration, /PRAGMA defer_foreign_keys = OFF/i);
  for (const table of constrainedTables) {
    assert.match(migration, new RegExp(`FROM\\s+${table}\\b`, 'i'));
    assert.match(migration, new RegExp(`DROP\\s+TABLE\\s+${table}\\b`, 'i'));
  }
  assert.equal((migration.match(/'trial','wallet','silver','gold','platinum'/g) || []).length, 3);
  assert.match(migration, /idx_wallet_topups_trial_once/);
  assert.match(migration, /PRAGMA foreign_key_check/i);
});

test('canonical schema and deployment workflows require the entry-plan migration', () => {
  assert.equal((schema.match(/'trial','wallet','silver','gold','platinum'/g) || []).length, 3);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_trial_once/);
  assert.match(stagingWorkflow, /021_business_entry_plans\.sql/);
  assert.match(stagingWorkflow, /\.plans == 3/);
  assert.match(productionWorkflow, /021_business_entry_plans\.sql/);
});
