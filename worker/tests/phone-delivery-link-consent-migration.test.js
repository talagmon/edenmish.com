import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, '../migrations/024_phone_delivery_link_consent.sql'),
  'utf8',
);

test('migration 024 stores an optional phone-link consent and timestamp', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY)');

  db.exec(migration);

  const columns = db.prepare(
    "SELECT * FROM pragma_table_info('orders') ORDER BY cid",
  ).all().map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value }));
  assert.deepEqual(columns.slice(1), [
    { name: 'phone_delivery_link_opt_in', notnull: 1, dflt_value: '0' },
    { name: 'phone_delivery_link_opt_in_at', notnull: 0, dflt_value: null },
  ]);
});

test('deployment workflows require migration 024 before phone links are enabled', () => {
  const staging = readFileSync(
    resolve(here, '../../.github/workflows/staging-worker.yml'),
    'utf8',
  );
  const production = readFileSync(
    resolve(here, '../../.github/workflows/production-deploy.yml'),
    'utf8',
  );
  assert.match(staging, /024_phone_delivery_link_consent\.sql/);
  assert.match(production, /024_phone_delivery_link_consent\.sql/);
});
