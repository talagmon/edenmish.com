import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { persistOpsDeliveryCompletion } from '../src/delivery-notification-outbox.js';
import { driverApiTest } from '../src/driver-api.js';

class SQLiteD1Statement {
  constructor(statement) {
    this.statement = statement;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.statement.get(...this.args) || null;
  }

  async all() {
    return { results: this.statement.all(...this.args) };
  }
}

class SQLiteD1 {
  constructor({ failAtBatchIndex = null } = {}) {
    this.db = new DatabaseSync(':memory:');
    this.failAtBatchIndex = failAtBatchIndex;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        phone_delivery_link_opt_in INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT,
        delivered_at INTEGER,
        payment_status TEXT,
        retained_by_driver TEXT,
        retained_at INTEGER
      );
      CREATE TABLE status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        at INTEGER NOT NULL,
        note TEXT
      );
      CREATE TABLE driver_shifts (
        id TEXT PRIMARY KEY,
        driver_id TEXT NOT NULL
      );
      CREATE TABLE driver_assignments (
        driver_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE driver_routes (
        id INTEGER PRIMARY KEY,
        shift_id TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE driver_route_stops (
        route_id INTEGER NOT NULL,
        stop_id TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        task_type TEXT NOT NULL
      );
      CREATE TABLE driver_execution_events (
        event_id TEXT PRIMARY KEY,
        driver_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        order_id INTEGER,
        stop_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        route_revision_seen INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        conflict_type TEXT,
        server_received_at INTEGER NOT NULL,
        correlation_id TEXT NOT NULL
      );
    `);
    this.db.exec(readFileSync(new URL('../migrations/019_delivery_notification_outbox.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/027_retained_failure_notifications.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.db.prepare(sql));
  }

  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        if (index === this.failAtBatchIndex) throw new Error('injected_batch_failure');
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  scalar(sql) {
    return this.db.prepare(sql).get();
  }
}

const order = {
  id: 9001,
  status: 'to_dropoff',
  email: 'customer@example.com',
  phone: '+972541234567',
  payment_method: 'immediate',
};

function seed(DB) {
  DB.db.prepare(`INSERT INTO orders
    (id, status, email, phone, payment_method, payment_status)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(order.id, order.status, order.email, order.phone, order.payment_method, 'paid');
}

function seedDriverRoute(DB) {
  seed(DB);
  DB.db.exec(`
    INSERT INTO driver_shifts (id, driver_id) VALUES ('sh_123', 'drv_eden');
    INSERT INTO driver_assignments (driver_id, shift_id, order_id, active)
      VALUES ('drv_eden', 'sh_123', 9001, 1);
    INSERT INTO driver_routes (id, shift_id, revision) VALUES (1, 'sh_123', 13);
    INSERT INTO driver_route_stops (route_id, stop_id, order_id, task_type)
      VALUES (1, 'stop_d1', 9001, 'dropoff');
  `);
}

function driverCompletionEvent(eventId) {
  return {
    event_id: eventId,
    event_type: 'delivery_completed',
    occurred_at: '2026-07-18T15:00:00Z',
    recorded_at_monotonic_ms: 42,
    shift_id: 'sh_123',
    order_id: 'ord_9001',
    stop_id: 'stop_d1',
    route_revision_seen: 13,
    payload: {},
  };
}

function retainedFailureEvent(eventId, disposition = 'hold_for_redelivery') {
  return {
    ...driverCompletionEvent(eventId),
    event_type: 'delivery_failed',
    payload: {
      reason: 'incorrect_address',
      disposition,
      note: 'לא ניתן היה למסור',
    },
  };
}

const driverAuth = { driver_id: 'drv_eden' };
const driverMeta = { requestId: '11111111-1111-4111-8111-111111111111' };

describe('delivery completion transaction', () => {
  test('a later statement failure rolls back order, history, transition, and jobs', async () => {
    const DB = new SQLiteD1({ failAtBatchIndex: 3 });
    seed(DB);

    await assert.rejects(
      persistOpsDeliveryCompletion(DB, order, {
        eventId: 'ops-delivered-9001',
        now: 1_000,
      }),
      /injected_batch_failure/,
    );

    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'to_dropoff');
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_completion_transitions').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 0);
  });

  test('competing completion identities produce one transition and one email job', async () => {
    const DB = new SQLiteD1();
    seed(DB);

    const first = await persistOpsDeliveryCompletion(DB, order, {
      eventId: 'ops-completion-a',
      now: 1_000,
    });
    const competing = await persistOpsDeliveryCompletion(DB, order, {
      eventId: 'ops-completion-b',
      now: 1_001,
    });

    assert.equal(first.transitioned, true);
    assert.equal(competing.transitioned, false);
    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'delivered');
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 1);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_completion_transitions').count, 1);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 1);
  });

  test('does not overwrite a concurrent terminal state after the Ops snapshot', async () => {
    const DB = new SQLiteD1();
    seed(DB);
    DB.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', order.id);

    const result = await persistOpsDeliveryCompletion(DB, order, {
      eventId: 'ops-delivered-stale',
      now: 1_000,
    });

    assert.equal(result.transitioned, false);
    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'cancelled');
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_completion_transitions').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 0);
  });

  test('rejects an illegal source state even when the supplied snapshot matches it', async () => {
    const DB = new SQLiteD1();
    seed(DB);
    DB.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('paid', order.id);

    const result = await persistOpsDeliveryCompletion(DB, { ...order, status: 'paid' }, {
      eventId: 'ops-delivered-illegal-source',
      now: 1_000,
    });

    assert.equal(result.transitioned, false);
    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'paid');
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_completion_transitions').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 0);
  });

  test('driver completion rolls back event, order, history, transition, and jobs together', async () => {
    const DB = new SQLiteD1({ failAtBatchIndex: 4 });
    seedDriverRoute(DB);

    await assert.rejects(
      driverApiTest.processEvent(
        { DB },
        driverAuth,
        driverMeta,
        driverCompletionEvent('33333333-3333-4333-8333-333333333333'),
      ),
      /injected_batch_failure/,
    );

    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'to_dropoff');
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM driver_execution_events').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_completion_transitions').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 0);
  });

  test('competing driver event IDs create one transition and one email job', async () => {
    const DB = new SQLiteD1();
    seedDriverRoute(DB);

    const first = await driverApiTest.processEvent(
      { DB },
      driverAuth,
      driverMeta,
      driverCompletionEvent('33333333-3333-4333-8333-333333333333'),
    );
    const competing = await driverApiTest.processEvent(
      { DB },
      driverAuth,
      { requestId: '22222222-2222-4222-8222-222222222222' },
      driverCompletionEvent('44444444-4444-4444-8444-444444444444'),
    );

    assert.equal(first.status, 'accepted');
    assert.equal(competing.status, 'accepted');
    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'delivered');
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM driver_execution_events').count, 2);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 1);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_completion_transitions').count, 1);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 1);
  });

  test('retained failure rolls back event, custody, history, and email job together', async () => {
    const DB = new SQLiteD1({ failAtBatchIndex: 3 });
    seedDriverRoute(DB);

    await assert.rejects(
      driverApiTest.processEvent(
        { DB },
        driverAuth,
        driverMeta,
        retainedFailureEvent('55555555-5555-4555-8555-555555555555'),
      ),
      /injected_batch_failure/,
    );

    assert.equal(DB.scalar('SELECT status FROM orders WHERE id = 9001').status, 'to_dropoff');
    assert.equal(DB.scalar('SELECT retained_by_driver FROM orders WHERE id = 9001').retained_by_driver, null);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM driver_execution_events').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 0);
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM delivery_notification_outbox').count, 0);
  });

  test('retained failure atomically records custody and one disposition-specific email job', async () => {
    const DB = new SQLiteD1();
    seedDriverRoute(DB);

    const result = await driverApiTest.processEvent(
      { DB },
      driverAuth,
      driverMeta,
      retainedFailureEvent('66666666-6666-4666-8666-666666666666'),
    );

    assert.equal(result.status, 'accepted');
    assert.deepEqual(
      { ...DB.scalar(`SELECT status, retained_by_driver FROM orders WHERE id = 9001`) },
      { status: 'failed', retained_by_driver: 'hold_for_redelivery' },
    );
    assert.equal(DB.scalar('SELECT COUNT(*) AS count FROM status_history').count, 1);
    assert.deepEqual(
      { ...DB.scalar(`SELECT transition, channel, template
        FROM delivery_notification_outbox WHERE order_id = 9001`) },
      {
        transition: 'delivery_failed_retained',
        channel: 'email',
        template: 'customer_delivery_failed_redelivery_hold',
      },
    );
  });
});
