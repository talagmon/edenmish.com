import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createRedeliveryCharge } from '../src/db.js';
import { makeSession } from '../src/integrations.js';

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
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.db.prepare(sql));
  }

  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
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

  row(sql) {
    return { ...this.db.prepare(sql).get() };
  }

  seedHeldOrder(now = Date.now()) {
    this.db.prepare(`INSERT INTO orders (
      id, token, status, name, phone, pickup, pickup_city, dropoff, dropoff_city,
      service, size, price, currency, payment_status, created_at, email,
      retained_by_driver, retained_at, pending_redelivery_json
    ) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?, 'standard', 'small', 50, 'ILS',
      'paid', ?, ?, 'hold_for_redelivery', ?, ?)`).run(
      9001,
      'trk_redelivery',
      'לקוח בדיקה',
      '0501111111',
      'דיזנגוף 1',
      'תל אביב',
      'כתובת ישנה',
      'רמת גן',
      now - 1_000,
      'customer@example.com',
      now,
      JSON.stringify({
        dropoff: 'ויצמן 14',
        dropoff_detail: 'דירה 3',
        dropoff_lat: 32.07,
        dropoff_lng: 34.81,
        dropoff_city: 'גבעתיים',
        zone: 1,
        fee: 25,
        submitted_at: now,
      }),
    );
  }
}

async function signedWebhook(body, secret = 'webhook-secret', topic = 'orders/paid') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hmac = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return new Request('https://find.edenmish.com/webhooks/shopify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-SHA256': hmac,
      'X-Shopify-Topic': topic,
    },
    body: raw,
  });
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('redelivery Shopify payment boundary', () => {
  test('does not create a charge from an address snapshot that has already changed', async () => {
    const DB = new SQLiteD1();
    const now = Date.now();
    DB.seedHeldOrder(now);
    const staleSnapshot = DB.row(
      'SELECT pending_redelivery_json FROM orders WHERE id = 9001',
    ).pending_redelivery_json;
    const changedSnapshot = JSON.stringify({
      ...JSON.parse(staleSnapshot),
      dropoff: 'כתובת מתוקנת אחרת',
      submitted_at: now + 1,
    });
    DB.db.prepare('UPDATE orders SET pending_redelivery_json = ? WHERE id = 9001')
      .run(changedSnapshot);

    const charge = await createRedeliveryCharge(DB, {
      id: 'rdl_stale',
      orderId: 9001,
      amountAgorot: 2500,
      addressSnapshotJson: staleSnapshot,
      now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });

    assert.equal(charge, null);
    assert.equal(
      DB.db.prepare('SELECT COUNT(*) AS count FROM redelivery_charges').get().count,
      0,
    );
  });

  test('tracking exposes an OTP-gated redelivery action without leaking staged JSON', async () => {
    const DB = new SQLiteD1();
    DB.seedHeldOrder();
    DB.db.exec(`UPDATE orders
      SET pending_redelivery_json = NULL, email_verified = 0
      WHERE id = 9001`);

    const response = await worker.fetch(new Request(
      'https://find.edenmish.com/api/orders/trk_redelivery',
    ), { DB });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.redelivery.state, 'address_required');
    assert.equal(body.redelivery.verification_required, true);
    assert.equal(body.order.pending_redelivery_json, undefined);
  });

  test('creates one purpose-specific Draft Order without changing the original payment', async () => {
    const DB = new SQLiteD1();
    DB.seedHeldOrder();
    let shopifyInput;
    let shopifyCalls = 0;
    globalThis.fetch = async (_url, options) => {
      if (!options?.body) throw new Error('webhook registrar is outside this test');
      shopifyInput = JSON.parse(options.body).variables.input;
      shopifyCalls += 1;
      return new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/8001',
              legacyResourceId: '8001',
              invoiceUrl: 'https://checkout.shopify.test/redelivery',
            },
            userErrors: [],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const response = await worker.fetch(new Request(
      'https://find.edenmish.com/api/orders/trk_redelivery/redelivery-payment',
      { method: 'POST' },
    ), {
      DB,
      SHOPIFY_SHOP: 'example.myshopify.com',
      SHOPIFY_ADMIN_TOKEN: 'shopify-test-token',
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.match(body.payment_url, /checkout\.shopify\.test\/redelivery/);
    const charge = DB.row('SELECT * FROM redelivery_charges WHERE order_id = 9001');
    assert.equal(charge.amount_agorot, 2500);
    assert.equal(
      charge.address_snapshot_json,
      DB.row('SELECT pending_redelivery_json FROM orders WHERE id = 9001')
        .pending_redelivery_json,
    );
    assert.equal(charge.status, 'link_sent');
    assert.equal(charge.shopify_draft_order_id, '8001');
    assert.equal(DB.row('SELECT price, payment_status FROM orders WHERE id = 9001').price, 50);
    assert.equal(DB.row('SELECT price, payment_status FROM orders WHERE id = 9001').payment_status, 'paid');
    assert.ok(shopifyInput.tags.includes('edenmish-redelivery'));
    const attributes = shopifyInput.lineItems[0].customAttributes;
    assert.ok(attributes.some(({ key }) => key === '_edenmish_redelivery_charge'));

    const replay = await worker.fetch(new Request(
      'https://find.edenmish.com/api/orders/trk_redelivery/redelivery-payment',
      { method: 'POST' },
    ), {
      DB,
      SHOPIFY_SHOP: 'example.myshopify.com',
      SHOPIFY_ADMIN_TOKEN: 'shopify-test-token',
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
    assert.equal(shopifyCalls, 1, 'a replay must not create a second Draft Order');
  });

  test('reconciles the extra charge, then lets Ops release the corrected route', async () => {
    const DB = new SQLiteD1();
    const now = Date.now();
    DB.seedHeldOrder(now);
    DB.db.prepare(`INSERT INTO redelivery_charges (
      id, order_id, amount_agorot, currency, status, payment_url, processor_ref,
      shopify_draft_order_id, address_snapshot_json, created_at, updated_at, expires_at
    ) VALUES (?, 9001, 2500, 'ILS', 'link_sent', ?, '8001', '8001',
      (SELECT pending_redelivery_json FROM orders WHERE id = 9001), ?, ?, ?)`).run(
      'rdl_test',
      'https://checkout.shopify.test/redelivery',
      now,
      now,
      now + 24 * 60 * 60 * 1000,
    );

    const webhook = await worker.fetch(await signedWebhook({
      id: 9100,
      draft_order_id: 8001,
      financial_status: 'paid',
      total_price: '25.00',
      currency: 'ILS',
      line_items: [{
        properties: [
          { name: '_tracking_token', value: 'trk_redelivery' },
          { name: '_edenmish_redelivery_charge', value: 'rdl_test' },
        ],
      }],
    }), { DB, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret' });

    assert.equal(webhook.status, 200);
    assert.deepEqual(await webhook.json(), { received: true, reconciled: true });
    assert.equal(DB.row("SELECT status FROM redelivery_charges WHERE id = 'rdl_test'").status, 'paid');
    assert.deepEqual(
      DB.row('SELECT price, payment_status, retained_by_driver FROM orders WHERE id = 9001'),
      { price: 50, payment_status: 'paid', retained_by_driver: 'hold_for_redelivery' },
    );
    assert.deepEqual(
      DB.row("SELECT amount, status FROM payments WHERE status = 'redelivery_paid'"),
      { amount: 2500, status: 'redelivery_paid' },
    );

    const session = await makeSession({ SESSION_SECRET: 'test-secret' });
    const release = await worker.fetch(new Request(
      'https://ops.edenmish.com/api/ops/orders/9001/release-redelivery',
      { method: 'POST', headers: { 'X-Ops': session } },
    ), { DB, SESSION_SECRET: 'test-secret' });

    assert.equal(release.status, 200);
    assert.deepEqual(
      DB.row('SELECT dropoff, dropoff_city, retained_by_driver FROM orders WHERE id = 9001'),
      { dropoff: 'ויצמן 14', dropoff_city: 'גבעתיים', retained_by_driver: 'redelivery' },
    );
    assert.equal(DB.row("SELECT status FROM redelivery_charges WHERE id = 'rdl_test'").status, 'released');
  });

  test('does not release an address that differs from the paid charge snapshot', async () => {
    const DB = new SQLiteD1();
    const now = Date.now();
    DB.seedHeldOrder(now);
    DB.db.prepare(`INSERT INTO redelivery_charges (
      id, order_id, amount_agorot, currency, status, address_snapshot_json,
      created_at, updated_at, expires_at, paid_at
    ) VALUES ('rdl_changed', 9001, 2500, 'ILS', 'paid',
      (SELECT pending_redelivery_json FROM orders WHERE id = 9001), ?, ?, ?, ?)`).run(
      now,
      now,
      now + 24 * 60 * 60 * 1000,
      now,
    );
    DB.db.prepare(`UPDATE orders
      SET pending_redelivery_json = json_set(
        pending_redelivery_json,
        '$.dropoff',
        'כתובת שלא שולמה'
      )
      WHERE id = 9001`).run();

    const session = await makeSession({ SESSION_SECRET: 'test-secret' });
    const release = await worker.fetch(new Request(
      'https://ops.edenmish.com/api/ops/orders/9001/release-redelivery',
      { method: 'POST', headers: { 'X-Ops': session } },
    ), { DB, SESSION_SECRET: 'test-secret' });

    assert.equal(release.status, 409);
    assert.equal((await release.json()).error, 'redelivery_address_changed');
    assert.deepEqual(
      DB.row('SELECT dropoff, retained_by_driver FROM orders WHERE id = 9001'),
      { dropoff: 'כתובת ישנה', retained_by_driver: 'hold_for_redelivery' },
    );
    assert.equal(
      DB.row("SELECT status FROM redelivery_charges WHERE id = 'rdl_changed'").status,
      'paid',
    );
  });

  test('flags a redelivery refund for manual review without changing the original payment', async () => {
    const DB = new SQLiteD1();
    const now = Date.now();
    DB.seedHeldOrder(now);
    DB.db.prepare(`INSERT INTO redelivery_charges (
      id, order_id, amount_agorot, currency, status, shopify_order_id,
      address_snapshot_json, created_at, updated_at, expires_at, paid_at
    ) VALUES ('rdl_refund', 9001, 2500, 'ILS', 'paid', '9100',
      (SELECT pending_redelivery_json FROM orders WHERE id = 9001), ?, ?, ?, ?)`).run(
      now,
      now,
      now + 24 * 60 * 60 * 1000,
      now,
    );

    const response = await worker.fetch(await signedWebhook({
      id: 9200,
      order_id: 9100,
      transactions: [{
        id: 9300,
        kind: 'refund',
        status: 'success',
        amount: '25.00',
        currency: 'ILS',
      }],
    }, 'webhook-secret', 'refunds/create'), {
      DB,
      SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });

    assert.equal(response.status, 200);
    assert.equal(DB.row("SELECT status FROM redelivery_charges WHERE id = 'rdl_refund'").status, 'mismatch');
    assert.deepEqual(
      DB.row('SELECT payment_status, review_flag, review_reason FROM orders WHERE id = 9001'),
      {
        payment_status: 'paid',
        review_flag: 1,
        review_reason: 'redelivery_refund_review',
      },
    );
  });
});
