import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  hashAnalyticsClaim,
  observeAnalyticsClaim,
  registerAnalyticsClaim,
} from '../src/analytics-conversion.js';
import { persistPaidOrderAndOpsWhatsAppJob } from '../src/delivery-notification-outbox.js';
import worker from '../src/index.js';

class Statement {
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

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    return new Statement(this.db.prepare(sql));
  }

  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seedOrder({
    id,
    token,
    price = 50,
    status = 'payment_sent',
    paymentStatus = 'link_sent',
    shopifyDraftOrderId = 123,
  }) {
    this.db.prepare(`INSERT INTO orders (
      id, token, status, price, currency, payment_status,
      shopify_draft_order_id, created_at
    ) VALUES (?, ?, ?, ?, 'ILS', ?, ?, ?)`).run(
      id,
      token,
      status,
      price,
      paymentStatus,
      shopifyDraftOrderId,
      Date.now(),
    );
  }
}

const CLAIM_ONE = '0123456789abcdef0123456789abcdef';
const CLAIM_TWO = 'abcdef0123456789abcdef0123456789';

async function shopifyWebhook(body, secret, signed = true) {
  const raw = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Topic': 'orders/paid',
  };
  if (signed) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(raw),
    );
    headers['X-Shopify-Hmac-SHA256'] = btoa(
      String.fromCharCode(...new Uint8Array(signature)),
    );
  }
  return new Request('https://find.edenmish.com/webhooks/shopify', {
    method: 'POST',
    headers,
    body: raw,
  });
}

const observeRequest = (
  credential,
  eligible = true,
  ip = '203.0.113.10',
) => new Request(
  'https://find.edenmish.com/api/analytics/paid-conversion',
  {
    method: 'POST',
    headers: {
      Origin: 'https://edenmish.com',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({ credential, eligible }),
  },
);

describe('privacy-safe paid conversion claims', () => {
  test('stores only a hash and emits once after the Shopify-authoritative transition', async () => {
    const DB = new D1();
    DB.seedOrder({ id: 1, token: 'ordinarytrackingtoken01' });

    assert.equal(await registerAnalyticsClaim(DB, 1, CLAIM_ONE, 1000), true);
    const stored = DB.db.prepare('SELECT * FROM analytics_conversion_claims').get();
    assert.equal(stored.claim_hash, await hashAnalyticsClaim(CLAIM_ONE));
    assert.ok(!JSON.stringify(stored).includes(CLAIM_ONE));
    assert.deepEqual(await observeAnalyticsClaim(DB, CLAIM_ONE, true, 2000), { status: 'pending' });

    const transition = await persistPaidOrderAndOpsWhatsAppJob(DB, 1, {
      amountAgorot: 5000,
      paymentRef: 'shopify-order-999',
      shopifyOrderId: '999',
      analyticsSettlement: true,
      now: 3000,
    });
    assert.equal(transition.transitioned, true);

    const [first, second] = await Promise.all([
      observeAnalyticsClaim(DB, CLAIM_ONE, true, 4000),
      observeAnalyticsClaim(DB, CLAIM_ONE, true, 4000),
    ]);
    const results = [first, second];
    assert.equal(results.filter(result => result.status === 'emitted').length, 1);
    assert.equal(results.filter(result => result.status === 'unavailable').length, 1);
    assert.deepEqual(results.find(result => result.status === 'emitted'), {
      status: 'emitted',
      event: 'paid_order',
      value: 50,
      currency: 'ILS',
    });
    assert.deepEqual(await observeAnalyticsClaim(DB, CLAIM_ONE, true, 5000), {
      status: 'unavailable',
    });
  });

  test('a refusal is permanent and cannot be backfilled after settlement', async () => {
    const DB = new D1();
    DB.seedOrder({ id: 2, token: 'refusedtrackingtoken01' });
    await registerAnalyticsClaim(DB, 2, CLAIM_TWO, 1000);

    assert.deepEqual(await observeAnalyticsClaim(DB, CLAIM_TWO, false, 2000), {
      status: 'suppressed',
    });
    await persistPaidOrderAndOpsWhatsAppJob(DB, 2, {
      amountAgorot: 5000,
      shopifyOrderId: '1000',
      analyticsSettlement: true,
      now: 3000,
    });
    assert.deepEqual(await observeAnalyticsClaim(DB, CLAIM_TWO, true, 4000), {
      status: 'unavailable',
    });
  });

  test('only a signed, matching Shopify webhook settles the browser claim', async () => {
    const DB = new D1();
    const secret = 'analytics-webhook-secret';
    const token = 'signedtrackingtoken001';
    DB.seedOrder({ id: 4, token, price: 50, shopifyDraftOrderId: 123 });
    await registerAnalyticsClaim(DB, 4, CLAIM_ONE, Date.now() - 1000);
    const payload = {
      id: 4004,
      draft_order_id: 123,
      financial_status: 'paid',
      total_price: '50.00',
      currency: 'ILS',
      line_items: [{
        properties: [{ name: '_tracking_token', value: token }],
      }],
    };

    const unsigned = await worker.fetch(
      await shopifyWebhook(payload, secret, false),
      { DB, SHOPIFY_WEBHOOK_SECRET: secret },
    );
    assert.equal(unsigned.status, 401);
    const pending = await worker.fetch(observeRequest(CLAIM_ONE), {
      DB,
      ALLOWED_ORIGINS: 'https://edenmish.com',
      SESSION_SECRET: 'analytics-rate-limit-secret',
    });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { status: 'pending' });

    const signed = await worker.fetch(
      await shopifyWebhook(payload, secret),
      { DB, SHOPIFY_WEBHOOK_SECRET: secret },
    );
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { received: true });
    const emitted = await worker.fetch(observeRequest(CLAIM_ONE), {
      DB,
      ALLOWED_ORIGINS: 'https://edenmish.com',
      SESSION_SECRET: 'analytics-rate-limit-secret',
    });
    assert.equal(emitted.status, 200);
    assert.deepEqual(await emitted.json(), {
      event: 'paid_order',
      value: 50,
      currency: 'ILS',
    });
    const replay = await worker.fetch(observeRequest(CLAIM_ONE), {
      DB,
      ALLOWED_ORIGINS: 'https://edenmish.com',
      SESSION_SECRET: 'analytics-rate-limit-secret',
    });
    assert.equal(replay.status, 204);
  });

  test('manual settlement, refund state, and malformed credentials never emit', async () => {
    const DB = new D1();
    DB.seedOrder({ id: 3, token: 'manualtrackingtoken001' });
    await registerAnalyticsClaim(DB, 3, CLAIM_ONE, 1000);
    await persistPaidOrderAndOpsWhatsAppJob(DB, 3, {
      amountAgorot: 5000,
      shopifyOrderId: '1001',
      analyticsSettlement: false,
      now: 2000,
    });
    assert.deepEqual(await observeAnalyticsClaim(DB, CLAIM_ONE, true, 3000), {
      status: 'pending',
    });

    DB.db.prepare(`UPDATE analytics_conversion_claims SET settled_at = 3500 WHERE order_id = 3`).run();
    DB.db.prepare(`UPDATE orders
      SET status = 'refund_pending', payment_status = 'refund_pending'
      WHERE id = 3`).run();
    assert.deepEqual(await observeAnalyticsClaim(DB, CLAIM_ONE, true, 4000), {
      status: 'suppressed',
    });
    assert.deepEqual(await observeAnalyticsClaim(DB, 'not-a-credential', true, 4000), {
      status: 'unavailable',
    });
  });

  test('rate-limits repeated public observations before claim lookup', async () => {
    const DB = new D1();
    const env = {
      DB,
      ALLOWED_ORIGINS: 'https://edenmish.com',
      SESSION_SECRET: 'analytics-rate-limit-secret',
    };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await worker.fetch(
        observeRequest(CLAIM_ONE, true, '203.0.113.40'),
        env,
      );
      assert.equal(response.status, 204);
    }
    const limited = await worker.fetch(
      observeRequest(CLAIM_ONE, true, '203.0.113.40'),
      env,
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
  });

  test('migration is additive, idempotent, and contains no PII columns', () => {
    const migration = readFileSync(
      new URL('../migrations/032_analytics_conversion_claims.sql', import.meta.url),
      'utf8',
    );
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY)');
    db.exec(migration);
    db.exec(migration);
    const columns = db.prepare(`SELECT name FROM pragma_table_info(
      'analytics_conversion_claims'
    ) ORDER BY cid`).all().map(row => row.name);
    assert.deepEqual(columns, [
      'claim_hash',
      'order_id',
      'disposition',
      'created_at',
      'expires_at',
      'settled_at',
      'observed_at',
    ]);
    for (const forbidden of ['name', 'email', 'phone', 'address', 'tracking_token']) {
      assert.ok(!columns.includes(forbidden));
    }

    const staging = readFileSync(
      new URL('../../.github/workflows/staging-worker.yml', import.meta.url),
      'utf8',
    );
    const production = readFileSync(
      new URL('../../.github/workflows/production-deploy.yml', import.meta.url),
      'utf8',
    );
    const migrations = readFileSync(new URL('../MIGRATIONS.md', import.meta.url), 'utf8');
    for (const source of [staging, production, migrations]) {
      assert.match(source, /032_analytics_conversion_claims\.sql/);
    }
  });
});
