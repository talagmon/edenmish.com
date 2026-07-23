import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, '../migrations/023_driver_login_invitations.sql'),
  'utf8',
);

test('migration 023 stores only hashed expiring per-driver invitations', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE drivers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'he-IL',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE driver_sessions (
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL
    );
  `);

  db.exec(migration);

  const columns = db.prepare(
    "SELECT name FROM pragma_table_info('driver_login_invitations') ORDER BY cid",
  ).all().map(({ name }) => name);
  assert.deepEqual(columns, [
    'id',
    'driver_id',
    'code_hash',
    'created_by',
    'created_at',
    'expires_at',
    'consumed_at',
    'consumed_session_id',
    'consumed_installation_id',
    'revoked_at',
  ]);
  assert.ok(!columns.includes('code'));
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_driver_login_invitations_driver',
        'idx_driver_login_invitations_active'
      )`).get().count,
    2,
  );
});

test('deployment workflows apply migration 023 before driver invitations are enabled', () => {
  const staging = readFileSync(
    resolve(here, '../../.github/workflows/staging-worker.yml'),
    'utf8',
  );
  const production = readFileSync(
    resolve(here, '../../.github/workflows/production-deploy.yml'),
    'utf8',
  );
  assert.match(staging, /023_driver_login_invitations\.sql/);
  assert.match(production, /023_driver_login_invitations\.sql/);
});
