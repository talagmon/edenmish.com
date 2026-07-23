import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const migration019 = readFileSync(
  resolve(here, '../migrations/019_delivery_notification_outbox.sql'),
  'utf8',
);
const migration027 = readFileSync(
  resolve(here, '../migrations/027_retained_failure_notifications.sql'),
  'utf8',
);

test('migration 027 preserves delivered jobs and permits retained-failure jobs', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orders (id INTEGER PRIMARY KEY);
    INSERT INTO orders (id) VALUES (9001);
  `);
  db.exec(migration019);
  db.exec(`
    INSERT INTO delivery_notification_outbox (
      order_id, transition, event_id, channel, template, state, attempt_count,
      next_attempt_at, lease_token, lease_expires_at, last_error, created_at,
      updated_at, sent_at
    ) VALUES (
      9001, 'delivered', 'delivered-event', 'email', 'customer_delivery_summary',
      'processing', 2, 1200, 'lease-1', 1300, 'temporary', 1000, 1100, NULL
    );
  `);

  db.exec(migration027);
  const preserved = { ...db.prepare(`SELECT transition, state, attempt_count, lease_token,
    lease_expires_at, last_error FROM delivery_notification_outbox`).get() };
  assert.deepEqual(preserved, {
    transition: 'delivered',
    state: 'processing',
    attempt_count: 2,
    lease_token: 'lease-1',
    lease_expires_at: 1300,
    last_error: 'temporary',
  });

  assert.doesNotThrow(() => db.exec(`
    INSERT INTO delivery_notification_outbox (
      order_id, transition, event_id, channel, template, state, attempt_count,
      next_attempt_at, created_at, updated_at
    ) VALUES (
      9001, 'delivery_failed_retained', 'failure-event', 'email',
      'customer_delivery_failed_returning', 'pending', 0, 1400, 1400, 1400
    );
  `));
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM pragma_index_list(
      'delivery_notification_outbox'
    ) WHERE name='idx_delivery_notification_outbox_due'`).get().count,
    1,
  );
});

test('deployment workflows require migration 027 before retained-failure emails', () => {
  const staging = readFileSync(
    resolve(here, '../../.github/workflows/staging-worker.yml'),
    'utf8',
  );
  const production = readFileSync(
    resolve(here, '../../.github/workflows/production-deploy.yml'),
    'utf8',
  );
  assert.match(staging, /027_retained_failure_notifications\.sql/);
  assert.match(production, /027_retained_failure_notifications\.sql/);
});
