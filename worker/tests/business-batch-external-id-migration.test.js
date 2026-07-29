import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const migration = readFileSync(
  new URL('../migrations/033_business_batch_external_id.sql', import.meta.url),
  'utf8',
);

test('migration 033 enforces one external batch ID per business account', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      business_account_id INTEGER
    );
  `);
  db.exec(migration);

  db.prepare(
    'INSERT INTO orders (id, business_account_id, business_external_id) VALUES (?, ?, ?)'
  ).run(1, 7, 'ORD-100');
  assert.throws(() => db.prepare(
    'INSERT INTO orders (id, business_account_id, business_external_id) VALUES (?, ?, ?)'
  ).run(2, 7, 'ORD-100'), /UNIQUE constraint failed/);

  db.prepare(
    'INSERT INTO orders (id, business_account_id, business_external_id) VALUES (?, ?, ?)'
  ).run(3, 8, 'ORD-100');
  db.prepare(
    'INSERT INTO orders (id, business_account_id, business_external_id) VALUES (?, ?, NULL)'
  ).run(4, 7);
  db.prepare(
    'INSERT INTO orders (id, business_account_id, business_external_id) VALUES (?, ?, NULL)'
  ).run(5, 7);

  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM pragma_table_info('orders') WHERE name='business_external_id'"
    ).get().count,
    1,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_orders_business_external_id'"
    ).get().count,
    1,
  );
  db.close();
});

test('deployment paths require migration 033 before batch runtime', () => {
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
    assert.match(text, /033_business_batch_external_id\.sql/);
  }
  assert.ok(
    staging.indexOf('033_business_batch_external_id.sql')
      < staging.indexOf('Deploy staging Worker'),
  );
});
