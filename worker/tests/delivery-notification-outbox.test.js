import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deliveryNotificationOutboxPolicy,
  enqueueDeliveryNotificationJobs,
  processDeliveryNotificationOutbox,
  retainedFailureNotificationOutboxStatements,
  retainedPackageFailureHtml,
} from '../src/delivery-notification-outbox.js';

class OutboxDb {
  constructor() {
    this.orders = new Map([[9001, {
      id: 9001,
      status: 'delivered',
      email: 'customer@example.com',
      phone: '+972541234567',
      dropoff: 'Drop-off address',
    }]]);
    this.jobs = [];
    this.nextId = 1;
  }

  prepare(sql) {
    const db = this;
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async all() {
        if (normalized.startsWith('SELECT id FROM delivery_notification_outbox')) {
          const [maxAttempts, dueAt, leaseAt, limit] = this.args;
          return { results: db.jobs
            .filter((job) => (
              job.attempt_count < maxAttempts && (
                (job.state === 'pending' && job.next_attempt_at <= dueAt)
                || (job.state === 'processing' && job.lease_expires_at <= leaseAt)
              )
            ))
            .sort((a, b) => a.next_attempt_at - b.next_attempt_at || a.id - b.id)
            .slice(0, limit)
            .map(({ id }) => ({ id })) };
        }
        return { results: [] };
      },
      async first() {
        if (normalized === 'SELECT * FROM orders WHERE id = ?') {
          return db.orders.get(this.args[0]) || null;
        }
        if (normalized.startsWith('SELECT * FROM delivery_notification_outbox')) {
          return db.jobs.find((job) => job.id === this.args[0] && job.lease_token === this.args[1]) || null;
        }
        return null;
      },
      async run() {
        if (normalized.startsWith("UPDATE delivery_notification_outbox SET state = 'dead'")) {
          const [updatedAt, maxAttempts, dueAt, leaseAt] = this.args;
          let changes = 0;
          for (const job of db.jobs) {
            const eligible = job.attempt_count >= maxAttempts && (
              (job.state === 'pending' && job.next_attempt_at <= dueAt)
              || (job.state === 'processing' && job.lease_expires_at <= leaseAt)
            );
            if (!eligible) continue;
            Object.assign(job, {
              state: 'dead', lease_token: null, lease_expires_at: null,
              last_error: 'attempt_limit_exhausted', updated_at: updatedAt,
            });
            changes += 1;
          }
          return { meta: { changes } };
        }
        if (normalized.startsWith('INSERT OR IGNORE INTO delivery_notification_outbox')) {
          const retainedFailure = normalized.includes("'delivery_failed_retained'");
          const [
            orderId, eventId, channelOrTemplate, templateOrNextAttempt,
            nextAttemptOrCreated, createdOrUpdated, updatedAt,
          ] = this.args;
          const transition = retainedFailure ? 'delivery_failed_retained' : 'delivered';
          const channel = retainedFailure ? 'email' : channelOrTemplate;
          const template = retainedFailure ? channelOrTemplate : templateOrNextAttempt;
          const nextAttemptAt = retainedFailure ? templateOrNextAttempt : nextAttemptOrCreated;
          const createdAt = retainedFailure ? nextAttemptOrCreated : createdOrUpdated;
          const finalUpdatedAt = retainedFailure ? createdOrUpdated : updatedAt;
          const duplicate = db.jobs.some((job) => (
            job.order_id === orderId && job.transition === transition
            && job.channel === channel && job.template === template
          ));
          if (duplicate) return { meta: { changes: 0 } };
          db.jobs.push({
            id: db.nextId++,
            order_id: orderId,
            transition,
            event_id: eventId,
            channel,
            template,
            state: 'pending',
            attempt_count: 0,
            next_attempt_at: nextAttemptAt,
            lease_token: null,
            lease_expires_at: null,
            last_error: null,
            created_at: createdAt,
            updated_at: finalUpdatedAt,
            sent_at: null,
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("UPDATE delivery_notification_outbox SET state = 'processing'")) {
          const [token, leaseExpiresAt, updatedAt, id, maxAttempts, dueAt, leaseAt] = this.args;
          const job = db.jobs.find((value) => value.id === id);
          const eligible = job && job.attempt_count < maxAttempts && (
            (job.state === 'pending' && job.next_attempt_at <= dueAt)
            || (job.state === 'processing' && job.lease_expires_at <= leaseAt)
          );
          if (!eligible) return { meta: { changes: 0 } };
          Object.assign(job, {
            state: 'processing',
            attempt_count: job.attempt_count + 1,
            lease_token: token,
            lease_expires_at: leaseExpiresAt,
            updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("UPDATE delivery_notification_outbox SET state = 'sent'")) {
          const [sentAt, updatedAt, id, token] = this.args;
          const job = db.jobs.find((value) => value.id === id && value.lease_token === token);
          if (!job) return { meta: { changes: 0 } };
          Object.assign(job, {
            state: 'sent', sent_at: sentAt, updated_at: updatedAt,
            lease_token: null, lease_expires_at: null, last_error: null,
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('UPDATE delivery_notification_outbox SET state = ?')) {
          const [state, nextAttemptAt, error, updatedAt, id, token] = this.args;
          const job = db.jobs.find((value) => value.id === id && value.lease_token === token);
          if (!job) return { meta: { changes: 0 } };
          Object.assign(job, {
            state, next_attempt_at: nextAttemptAt, last_error: error,
            updated_at: updatedAt, lease_token: null, lease_expires_at: null,
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  async batch(statements) {
    const snapshot = structuredClone(this.jobs);
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.jobs = snapshot;
      throw error;
    }
  }
}

const order = {
  id: 9001,
  email: 'customer@example.com',
  phone: '+972541234567',
};

describe('delivery notification outbox', () => {
  test('event replay creates one email job and never infers phone consent', async () => {
    const DB = new OutboxDb();
    const options = { eventId: 'event-1', now: 1_000, sendWhatsApp: true };

    await Promise.all([
      enqueueDeliveryNotificationJobs(DB, order, options),
      enqueueDeliveryNotificationJobs(DB, order, options),
    ]);

    assert.deepEqual(DB.jobs.map((job) => job.channel), ['email']);
    assert.equal(new Set(DB.jobs.map((job) => `${job.order_id}:${job.channel}`)).size, 1);
    assert.deepEqual(deliveryNotificationOutboxPolicy.channels, ['email', 'whatsapp_opt_in']);
    assert.equal(deliveryNotificationOutboxPolicy.phoneDeliveryRequiresPersistedOptIn, true);
  });

  test('explicit persisted phone consent adds one WhatsApp proof-link job', async () => {
    const DB = new OutboxDb();
    await enqueueDeliveryNotificationJobs(
      DB,
      { ...order, phone_delivery_link_opt_in: 1 },
      { eventId: 'event-consented', now: 1_000 },
    );

    assert.deepEqual(DB.jobs.map((job) => job.channel), ['email', 'whatsapp']);
  });

  test('retained failures enqueue one email job without reusing proof-link phone consent', async () => {
    const DB = new OutboxDb();
    const retained = {
      ...order,
      phone_delivery_link_opt_in: 1,
    };
    await DB.batch(retainedFailureNotificationOutboxStatements(
      DB,
      retained,
      'failure-event-1',
      'hold_for_redelivery',
      1_000,
    ));

    assert.deepEqual(DB.jobs.map(({ transition, channel, template }) => ({
      transition, channel, template,
    })), [{
      transition: 'delivery_failed_retained',
      channel: 'email',
      template: 'customer_delivery_failed_redelivery_hold',
    }]);
    assert.deepEqual(deliveryNotificationOutboxPolicy.retainedFailureChannels, ['email']);
  });

  test('retained-failure email gives a truthful 24-hour next step and tracking link', async () => {
    const DB = new OutboxDb();
    const retained = {
      ...order,
      token: 'retained-token-9001',
      phone_delivery_link_opt_in: 1,
    };
    DB.orders.set(order.id, retained);
    await DB.batch(retainedFailureNotificationOutboxStatements(
      DB,
      retained,
      'failure-event-1',
      'hold_for_redelivery',
      1_000,
    ));
    const originalFetch = globalThis.fetch;
    let outbound;
    globalThis.fetch = async (_url, options) => {
      outbound = JSON.parse(options.body);
      return { ok: true };
    };

    try {
      const summary = await processDeliveryNotificationOutbox({
        DB,
        STOREFRONT_BASE: 'https://edenmish.com',
        SENDGRID_API_KEY: 'test-key',
      }, { now: 1_000 });

      assert.deepEqual(summary, { claimed: 1, sent: 1, retried: 0, dead: 0 });
      assert.match(outbound.subject, /תיאום למסירה מחדש/);
      assert.match(outbound.content[0].value, /בתוך 24 שעות/);
      assert.match(
        outbound.content[0].value,
        /https:\/\/edenmish\.com\/track\.html\?t=retained-token-9001/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returning failure copy requires no customer action and escapes order data', () => {
    const html = retainedPackageFailureHtml(
      { STOREFRONT_BASE: 'https://edenmish.com' },
      { id: '<9001>', token: 'return-token' },
      deliveryNotificationOutboxPolicy.templates.retainedReturning,
    );

    assert.match(html, /אין צורך בפעולה כרגע/);
    assert.match(html, /#&lt;9001&gt;/);
    assert.doesNotMatch(html, /#<9001>/);
  });

  test('consented WhatsApp delivery contains the customer proof link', async () => {
    const DB = new OutboxDb();
    const consented = {
      ...order,
      token: 'proof-token-9001',
      email: null,
      phone_delivery_link_opt_in: 1,
    };
    DB.orders.set(order.id, consented);
    await enqueueDeliveryNotificationJobs(
      DB,
      consented,
      { eventId: 'event-phone-link', now: 1_000 },
    );
    const originalFetch = globalThis.fetch;
    let outbound;
    globalThis.fetch = async (_url, options) => {
      outbound = JSON.parse(options.body);
      return { ok: true };
    };

    try {
      const summary = await processDeliveryNotificationOutbox({
        DB,
        STOREFRONT_BASE: 'https://edenmish.com',
        WHATSAPP_TOKEN: 'test-token',
        WHATSAPP_PHONE_ID: 'test-phone-id',
      }, { now: 1_000 });

      assert.deepEqual(summary, { claimed: 1, sent: 1, retried: 0, dead: 0 });
      assert.match(
        outbound.text.body,
        /https:\/\/edenmish\.com\/delivered\.html\?t=proof-token-9001/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('failed work backs off and later succeeds with the same logical job', async () => {
    const DB = new OutboxDb();
    await enqueueDeliveryNotificationJobs(DB, order, { eventId: 'event-1', now: 1_000 });
    let calls = 0;
    const deliver = async () => ({ ok: ++calls > 1, error: 'temporary' });

    const first = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_000, retryMs: 100, deliver,
    });
    const tooSoon = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_099, retryMs: 100, deliver,
    });
    const recovered = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_100, retryMs: 100, deliver,
    });

    assert.deepEqual(first, { claimed: 1, sent: 0, retried: 1, dead: 0 });
    assert.deepEqual(tooSoon, { claimed: 0, sent: 0, retried: 0, dead: 0 });
    assert.deepEqual(recovered, { claimed: 1, sent: 1, retried: 0, dead: 0 });
    assert.equal(DB.jobs[0].attempt_count, 2);
    assert.equal(DB.jobs[0].state, 'sent');
  });

  test('legacy phone jobs are permanently disabled without persisted opt-in', async () => {
    const DB = new OutboxDb();
    DB.jobs.push({
      id: DB.nextId++,
      order_id: order.id,
      transition: 'delivered',
      event_id: 'legacy-event',
      channel: 'whatsapp',
      template: deliveryNotificationOutboxPolicy.template,
      state: 'pending',
      attempt_count: 0,
      next_attempt_at: 1_000,
      lease_token: null,
      lease_expires_at: null,
      last_error: null,
      created_at: 1_000,
      updated_at: 1_000,
      sent_at: null,
    });

    const summary = await processDeliveryNotificationOutbox({ DB }, { now: 1_000 });

    assert.deepEqual(summary, { claimed: 1, sent: 0, retried: 0, dead: 1 });
    assert.equal(DB.jobs[0].state, 'dead');
    assert.equal(DB.jobs[0].last_error, 'phone_channel_requires_opt_in');
  });

  test('concurrent processors lease one job to one sender', async () => {
    const DB = new OutboxDb();
    await enqueueDeliveryNotificationJobs(DB, order, { eventId: 'event-1', now: 1_000 });
    let sends = 0;
    const deliver = async () => { sends += 1; return { ok: true }; };

    const summaries = await Promise.all([
      processDeliveryNotificationOutbox({ DB }, { now: 1_000, deliver }),
      processDeliveryNotificationOutbox({ DB }, { now: 1_000, deliver }),
    ]);

    assert.equal(sends, 1);
    assert.equal(summaries.reduce((total, value) => total + value.claimed, 0), 1);
    assert.equal(DB.jobs[0].state, 'sent');
  });

  test('retry count is bounded and exhausts to dead', async () => {
    const DB = new OutboxDb();
    await enqueueDeliveryNotificationJobs(DB, order, { eventId: 'event-1', now: 1_000 });
    const deliver = async () => ({ ok: false, error: 'still_down' });

    await processDeliveryNotificationOutbox({ DB }, {
      now: 1_000, retryMs: 100, maxAttempts: 2, deliver,
    });
    const exhausted = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_100, retryMs: 100, maxAttempts: 2, deliver,
    });

    assert.deepEqual(exhausted, { claimed: 1, sent: 0, retried: 0, dead: 1 });
    assert.equal(DB.jobs[0].attempt_count, 2);
    assert.equal(DB.jobs[0].state, 'dead');
  });

  test('each invocation processes no more than its configured bound', async () => {
    const DB = new OutboxDb();
    for (let id = 9001; id <= 9003; id += 1) {
      const value = { id, email: `customer-${id}@example.com` };
      DB.orders.set(id, { ...value, status: 'delivered' });
      await enqueueDeliveryNotificationJobs(DB, value, {
        eventId: `event-${id}`,
        now: 1_000,
      });
    }
    let sends = 0;

    const summary = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_000,
      limit: 2,
      deliver: async () => { sends += 1; return { ok: true }; },
    });

    assert.equal(sends, 2);
    assert.deepEqual(summary, { claimed: 2, sent: 2, retried: 0, dead: 0 });
    assert.equal(DB.jobs.filter((job) => job.state === 'pending').length, 1);
  });

  test('an expired lease is reclaimed after a worker crash', async () => {
    const DB = new OutboxDb();
    await enqueueDeliveryNotificationJobs(DB, order, { eventId: 'event-1', now: 1_000 });
    Object.assign(DB.jobs[0], {
      state: 'processing',
      attempt_count: 1,
      lease_token: 'abandoned-worker',
      lease_expires_at: 1_050,
    });
    let sends = 0;

    const beforeExpiry = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_049,
      deliver: async () => { sends += 1; return { ok: true }; },
    });
    const afterExpiry = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_050,
      deliver: async () => { sends += 1; return { ok: true }; },
    });

    assert.equal(beforeExpiry.claimed, 0);
    assert.equal(afterExpiry.sent, 1);
    assert.equal(sends, 1);
    assert.equal(DB.jobs[0].attempt_count, 2);
  });

  test('an expired lease at the attempt limit is dead-lettered without another send', async () => {
    const DB = new OutboxDb();
    await enqueueDeliveryNotificationJobs(DB, order, { eventId: 'event-1', now: 1_000 });
    Object.assign(DB.jobs[0], {
      state: 'processing',
      attempt_count: 2,
      lease_token: 'crashed-final-attempt',
      lease_expires_at: 1_050,
    });
    let sends = 0;

    const summary = await processDeliveryNotificationOutbox({ DB }, {
      now: 1_050,
      maxAttempts: 2,
      deliver: async () => { sends += 1; return { ok: true }; },
    });

    assert.deepEqual(summary, { claimed: 0, sent: 0, retried: 0, dead: 1 });
    assert.equal(sends, 0);
    assert.equal(DB.jobs[0].state, 'dead');
    assert.equal(DB.jobs[0].last_error, 'attempt_limit_exhausted');
  });
});
