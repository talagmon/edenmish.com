import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const migration = readFileSync(
  resolve(import.meta.dirname, '../migrations/037_driver_push_devices.sql'),
  'utf8',
);

test('driver push migration creates the device registry and active lookup index', () => {
  const DB = new DatabaseSync(':memory:');
  DB.exec('PRAGMA foreign_keys = ON;');
  DB.exec(`CREATE TABLE drivers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    locale TEXT NOT NULL,
    active INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  DB.exec(migration);

  const columns = DB.prepare(
    "SELECT name FROM pragma_table_info('driver_push_devices') ORDER BY cid",
  ).all().map((row) => row.name);
  assert.deepEqual(columns, [
    'installation_id',
    'driver_id',
    'device_token',
    'environment',
    'app_bundle_id',
    'created_at',
    'updated_at',
    'last_seen_at',
    'disabled_at',
    'last_error',
    'last_success_at',
  ]);
  assert.equal(
    DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_driver_push_devices_active'`).get().count,
    1,
  );
});
