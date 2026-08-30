import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../migrations/038_business_delivery_exceptions.sql', import.meta.url),
  'utf8',
);

test('migration 038 creates the guarded one-use exception table and lookup index', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE business_accounts (id INTEGER PRIMARY KEY);
      CREATE TABLE orders (id INTEGER PRIMARY KEY);
    `);
    db.exec(migration);
    const objects = db.prepare(`SELECT name, type FROM sqlite_master
      WHERE name IN (
        'business_delivery_exceptions',
        'idx_business_delivery_exceptions_lookup'
      ) ORDER BY name`).all();
    assert.deepEqual(objects.map(({ name, type }) => ({ name, type })), [
      { name: 'business_delivery_exceptions', type: 'table' },
      { name: 'idx_business_delivery_exceptions_lookup', type: 'index' },
    ]);
    assert.throws(() => db.prepare(`INSERT INTO business_delivery_exceptions
      (account_id, external_id, zone, service, price_agorot, expires_at, created_at)
      VALUES (1, 'ROW-1', 4, 'standard', 11500, 1, 1)`).run());
  } finally {
    db.close();
  }
});

test('deployment paths require migration 038 before exception lookups are deployed', () => {
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
    assert.match(text, /038_business_delivery_exceptions\.sql/);
  }
  assert.ok(
    staging.indexOf('038_business_delivery_exceptions.sql')
      < staging.indexOf('Deploy staging Worker'),
  );
  assert.match(staging, /business_delivery_exceptions/);
});
