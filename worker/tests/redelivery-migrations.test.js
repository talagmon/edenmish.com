import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const retainedMigration = readFileSync(
  resolve(here, '../migrations/025_delivery_failure_retained_package.sql'),
  'utf8',
);
const redeliveryMigration = readFileSync(
  resolve(here, '../migrations/026_redelivery_pending_address.sql'),
  'utf8',
);

test('migrations 025 and 026 add retained-package and staged-redelivery state', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY)');

  db.exec(retainedMigration);
  db.exec(redeliveryMigration);

  const columns = db.prepare(
    "SELECT name FROM pragma_table_info('orders') ORDER BY cid",
  ).all().map(({ name }) => name);
  assert.deepEqual(columns.slice(1), [
    'retained_by_driver',
    'retained_at',
    'pending_redelivery_json',
  ]);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='index' AND name='idx_orders_retained_by_driver'`).get().count,
    1,
  );
});

test('deployment workflows require migrations 025 and 026 before redelivery is enabled', () => {
  const staging = readFileSync(
    resolve(here, '../../.github/workflows/staging-worker.yml'),
    'utf8',
  );
  const production = readFileSync(
    resolve(here, '../../.github/workflows/production-deploy.yml'),
    'utf8',
  );
  for (const filename of [
    '025_delivery_failure_retained_package.sql',
    '026_redelivery_pending_address.sql',
  ]) {
    assert.match(staging, new RegExp(filename.replace('.', '\\.')));
    assert.match(production, new RegExp(filename.replace('.', '\\.')));
  }
});
