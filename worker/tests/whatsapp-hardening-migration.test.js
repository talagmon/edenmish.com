import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  persistPaidOrderAndOpsWhatsAppJob,
} from '../src/delivery-notification-outbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration005 = readFileSync(
  resolve(here, '../migrations/005_notifications.sql'),
  'utf8',
);
const migration019 = readFileSync(
  resolve(here, '../migrations/019_delivery_notification_outbox.sql'),
  'utf8',
);
const migration027 = readFileSync(
  resolve(here, '../migrations/027_retained_failure_notifications.sql'),
  'utf8',
);
const migration030 = readFileSync(
  resolve(here, '../migrations/030_whatsapp_template_delivery_audit.sql'),
  'utf8',
);

class SqliteD1 {
  constructor(database, failAfter = null) {
    this.database = database;
    this.failAfter = failAfter;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      run() {
        const result = statement.run(...this.args);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }

  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (index === this.failAfter) throw new Error('simulated_batch_failure');
        results.push(await statements[index].run());
      }
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function paymentDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      status TEXT,
      payment_status TEXT,
      shopify_order_id TEXT
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      amount INTEGER,
      currency TEXT,
      payplus_id TEXT,
      status TEXT,
      url TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER
    );
    CREATE TABLE status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      at INTEGER NOT NULL,
      note TEXT
    );
  `);
  db.exec(migration005);
  db.exec(migration019);
  db.exec(migration027);
  db.exec(migration030);
  return db;
}

test('migration 030 preserves jobs and adds sanitized WhatsApp audit readiness', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orders (id INTEGER PRIMARY KEY);
    INSERT INTO orders (id) VALUES (9001);
  `);
  db.exec(migration005);
  db.exec(migration019);
  db.exec(migration027);
  db.exec(`
    INSERT INTO notifications (
      order_id, channel, template, recipient, subject, status, provider_ref,
      created_at, updated_at
    ) VALUES (
      9001, 'whatsapp', 'customer_delivery_summary', NULL, NULL, 'sent',
      'wamid.existing', 1000, 1000
    );
    INSERT INTO delivery_notification_outbox (
      order_id, transition, event_id, channel, template, state, attempt_count,
      next_attempt_at, lease_token, lease_expires_at, last_error, created_at,
      updated_at, sent_at
    ) VALUES (
      9001, 'delivered', 'delivery-event', 'email', 'customer_delivery_summary',
      'processing', 2, 1200, 'lease-1', 1300, 'temporary', 1000, 1100, NULL
    );
  `);

  db.exec(migration030);

  assert.deepEqual(
    { ...db.prepare(`SELECT transition, state, attempt_count, lease_token,
      lease_expires_at, last_error FROM delivery_notification_outbox`).get() },
    {
      transition: 'delivered',
      state: 'processing',
      attempt_count: 2,
      lease_token: 'lease-1',
      lease_expires_at: 1300,
      last_error: 'temporary',
    },
  );
  assert.doesNotThrow(() => db.exec(`
    INSERT INTO delivery_notification_outbox (
      order_id, transition, event_id, channel, template, state, attempt_count,
      next_attempt_at, created_at, updated_at
    ) VALUES (
      9001, 'payment_received', 'payment-event', 'whatsapp',
      'ops_payment_received', 'pending', 0, 1400, 1400, 1400
    );
  `));

  const columns = db.prepare(
    "SELECT name FROM pragma_table_info('notifications') ORDER BY cid",
  ).all().map(({ name }) => name);
  assert.ok(columns.includes('provider_status'));
  assert.ok(columns.includes('provider_updated_at'));
  const outboxColumns = db.prepare(
    "SELECT name FROM pragma_table_info('delivery_notification_outbox') ORDER BY cid",
  ).all().map(({ name }) => name);
  assert.ok(outboxColumns.includes('provider_ref'));
  assert.ok(outboxColumns.includes('provider_status'));
  assert.ok(outboxColumns.includes('provider_updated_at'));
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM pragma_index_list('notifications')
      WHERE name='idx_notifications_provider_ref'`).get().count,
    1,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM pragma_index_list(
      'delivery_notification_outbox'
    ) WHERE name='idx_delivery_notification_outbox_provider_ref'`).get().count,
    1,
  );
  assert.throws(() => db.exec(`
    INSERT INTO notifications (
      channel, template, status, provider_ref, created_at, updated_at
    ) VALUES (
      'whatsapp', 'ops_payment_received', 'sent', 'wamid.existing', 2, 2
    );
  `), /UNIQUE constraint failed/);
});

test('paid status, payment, history, and operations outbox commit atomically', async () => {
  const db = paymentDatabase();
  db.exec(`INSERT INTO orders (id, status, payment_status)
    VALUES (9001, 'payment_sent', 'link_sent')`);
  const D1 = new SqliteD1(db);

  assert.deepEqual(
    await persistPaidOrderAndOpsWhatsAppJob(D1, 9001, {
      amountAgorot: 5000,
      paymentRef: 'shopify-1',
      shopifyOrderId: 'shopify-1',
      now: 1_000,
    }),
    { eventId: 'payment-received-9001', transitioned: true },
  );
  assert.deepEqual(
    { ...db.prepare(`SELECT status, payment_status, shopify_order_id
      FROM orders WHERE id = 9001`).get() },
    {
      status: 'paid',
      payment_status: 'paid',
      shopify_order_id: 'shopify-1',
    },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM status_history').get().count, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM delivery_notification_outbox').get().count,
    1,
  );
  assert.deepEqual(
    await persistPaidOrderAndOpsWhatsAppJob(D1, 9001, {
      amountAgorot: 5000,
      paymentRef: 'shopify-1',
      shopifyOrderId: 'shopify-1',
      now: 2_000,
    }),
    { eventId: 'payment-received-9001', transitioned: false },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments').get().count, 1);

  const failedDb = paymentDatabase();
  failedDb.exec(`INSERT INTO orders (id, status, payment_status)
    VALUES (9002, 'payment_sent', 'link_sent')`);
  await assert.rejects(
    persistPaidOrderAndOpsWhatsAppJob(new SqliteD1(failedDb, 2), 9002, {
      amountAgorot: 5000,
      now: 3_000,
    }),
    /simulated_batch_failure/,
  );
  assert.deepEqual(
    { ...failedDb.prepare(`SELECT status, payment_status
      FROM orders WHERE id = 9002`).get() },
    { status: 'payment_sent', payment_status: 'link_sent' },
  );
  assert.equal(
    failedDb.prepare('SELECT COUNT(*) AS count FROM delivery_notification_outbox').get().count,
    0,
  );
  assert.equal(failedDb.prepare('SELECT COUNT(*) AS count FROM payments').get().count, 0);
  assert.equal(failedDb.prepare('SELECT COUNT(*) AS count FROM status_history').get().count, 0);
});

test('deployment workflows require migration 030 before WhatsApp activation', () => {
  const staging = readFileSync(
    resolve(here, '../../.github/workflows/staging-worker.yml'),
    'utf8',
  );
  const production = readFileSync(
    resolve(here, '../../.github/workflows/production-deploy.yml'),
    'utf8',
  );
  assert.match(staging, /030_whatsapp_template_delivery_audit\.sql/);
  assert.match(production, /030_whatsapp_template_delivery_audit\.sql/);
});
