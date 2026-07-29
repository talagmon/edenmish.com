import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const migration = readFileSync(
  new URL('../migrations/034_business_batch_mappings.sql', import.meta.url),
  'utf8',
);

test('migration 034 creates account-scoped approved batch mappings', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE business_accounts (id INTEGER PRIMARY KEY)');
  db.exec(migration);
  db.exec(migration);

  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='business_batch_mappings'"
    ).get().count,
    1,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_business_batch_mappings_account'"
    ).get().count,
    1,
  );
  db.close();
});

test('deployment paths require migration 034 before saved mappings are used', () => {
  const production = readFileSync(
    new URL('../../.github/workflows/production-deploy.yml', import.meta.url),
    'utf8',
  );
  const staging = readFileSync(
    new URL('../../.github/workflows/staging-worker.yml', import.meta.url),
    'utf8',
  );
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  for (const text of [production, staging, readme]) {
    assert.match(text, /034_business_batch_mappings\.sql/);
  }
  assert.ok(
    staging.indexOf('034_business_batch_mappings.sql')
      < staging.indexOf('Deploy staging Worker'),
  );
});
