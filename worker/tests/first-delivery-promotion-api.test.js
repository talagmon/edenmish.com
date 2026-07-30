import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const openDatabases = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  while (openDatabases.length) openDatabases.pop().close();
});

function d1Database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const wrap = (statement) => {
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  };
  return {
    sqlite,
    prepare(sql) { return wrap(sqlite.prepare(sql)); },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const orderBody = {
  name: 'New Customer',
  phone: '054-123-4567',
  email: 'new@example.com',
  pickup: 'דיזנגוף 1, תל אביב',
  dropoff: 'ביאליק 2, רמת גן',
  pickup_city: 'תל אביב',
  dropoff_city: 'רמת גן',
  service: 'standard',
  size: 'small',
  when_text: '10:00-12:00 · 27/07',
  when_date: '2026-07-27',
  when_hour: 10,
};

let ipSequence = 10;
function post(path, body) {
  return new Request(`https://find.edenmish.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': `203.0.113.${ipSequence++}`,
    },
    body: JSON.stringify(body),
  });
}

const envFor = (DB) => ({ DB, SESSION_SECRET: 'promotion-test-secret', TEST_MODE: '1' });

describe('automatic first-delivery promotion API', () => {
  test('previews and creates one discounted private order from authoritative pricing', async () => {
    const DB = d1Database();
    openDatabases.push(DB.sqlite);

    let response = await worker.fetch(
      post('/api/coupons/auto-apply', orderBody),
      envFor(DB),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      applied: true,
      valid: true,
      automatic: true,
      subtotal_price: 50,
      discount_amount: 5,
      price: 45,
      title: '10% הנחה למשלוח ראשון',
    });

    response = await worker.fetch(
      post('/api/orders', { ...orderBody, promotion_expected: true }),
      envFor(DB),
    );
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.subtotal_price, 50);
    assert.equal(created.discount_amount, 5);
    assert.equal(created.discount_code, 'FIRST10-2026');
    assert.equal(created.price, 45);

    const order = DB.sqlite.prepare(
      `SELECT price, subtotal_price, discount_code, discount_amount
       FROM orders WHERE id = ?`
    ).get(created.order_id);
    assert.deepEqual({ ...order }, {
      price: 45,
      subtotal_price: 50,
      discount_code: 'FIRST10-2026',
      discount_amount: 5,
    });
    const claim = DB.sqlite.prepare(
      `SELECT order_id, phone_key, email_key, status
       FROM first_delivery_promotion_claims`
    ).get();
    assert.deepEqual({ ...claim }, {
      order_id: created.order_id,
      phone_key: '+972541234567',
      email_key: 'new@example.com',
      status: 'redeemed',
    });

    response = await worker.fetch(
      post('/api/orders', { ...orderBody, promotion_expected: true }),
      envFor(DB),
    );
    assert.equal(response.status, 409);
    const duplicate = await response.json();
    assert.equal(duplicate.reason, 'not_new_customer');
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  });

  test('releases the promotion and redemption when Shopify checkout fails, then discounts the retry', async () => {
    const DB = d1Database();
    openDatabases.push(DB.sqlite);
    let draftAttempts = 0;
    globalThis.fetch = async (requestUrl, options = {}) => {
      if (String(requestUrl).endsWith('/webhooks.json')) {
        return new Response(JSON.stringify({
          webhooks: [
            { topic: 'orders/paid', address: 'https://find.edenmish.com/webhooks/shopify' },
            { topic: 'orders/updated', address: 'https://find.edenmish.com/webhooks/shopify' },
            { topic: 'refunds/create', address: 'https://find.edenmish.com/webhooks/shopify' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const request = JSON.parse(options.body || '{}');
      assert.match(request.query || '', /draftOrderCreate/);
      draftAttempts += 1;
      if (draftAttempts === 1) {
        return new Response(JSON.stringify({
          data: {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [{ field: ['input', 'email'], message: 'Email is invalid' }],
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/200',
              legacyResourceId: '200',
              invoiceUrl: 'https://test.myshopify.com/invoice/retry',
            },
            userErrors: [],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const env = {
      DB,
      SESSION_SECRET: 'promotion-test-secret',
      SHOPIFY_SHOP: 'test.myshopify.com',
      SHOPIFY_ADMIN_TOKEN: 'shopify-test-token',
      SHOPIFY_API_VERSION: '2026-04',
      OPS_EMAIL: 'ops@example.com',
    };

    let response = await worker.fetch(
      post('/api/orders', { ...orderBody, promotion_expected: true }),
      env,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'payment_checkout_unavailable',
      retryable: true,
      order_id: 1,
    });
    const failedOrder = DB.sqlite.prepare(
      `SELECT status, payment_status, review_reason, price, subtotal_price,
              discount_code, discount_amount
       FROM orders WHERE id = 1`
    ).get();
    assert.deepEqual({ ...failedOrder }, {
      status: 'cancelled',
      payment_status: 'checkout_failed',
      review_reason: 'checkout_creation_failed',
      price: 45,
      subtotal_price: 50,
      discount_code: 'FIRST10-2026',
      discount_amount: 5,
    });
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM first_delivery_promotion_claims').get().count,
      0,
    );
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM coupon_redemptions').get().count,
      0,
    );
    assert.equal(
      DB.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM status_history
         WHERE order_id = 1 AND status = 'cancelled'
           AND note = 'checkout_creation_failed'`
      ).get().count,
      1,
    );
    assert.equal(
      DB.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM notifications
         WHERE order_id = 1 AND template = 'ops_new_order'`
      ).get().count,
      0,
    );

    response = await worker.fetch(
      post('/api/orders', { ...orderBody, promotion_expected: true }),
      env,
    );
    assert.equal(response.status, 200);
    const retry = await response.json();
    assert.equal(retry.order_id, 2);
    assert.equal(retry.status, 'payment_sent');
    assert.equal(retry.payment_url, 'https://test.myshopify.com/invoice/retry?locale=he');
    assert.equal(retry.price, 45);
    assert.equal(retry.discount_code, 'FIRST10-2026');
    assert.equal(draftAttempts, 2);
    assert.deepEqual(
      {
        ...DB.sqlite.prepare(
          `SELECT order_id, status FROM first_delivery_promotion_claims`
        ).get(),
      },
      { order_id: 2, status: 'redeemed' },
    );
    assert.deepEqual(
      {
        ...DB.sqlite.prepare(
          `SELECT order_id, code, price_before, discount_amount, price_after
           FROM coupon_redemptions`
        ).get(),
      },
      {
        order_id: 2,
        code: 'FIRST10-2026',
        price_before: 50,
        discount_amount: 5,
        price_after: 45,
      },
    );
  });

  test('prior paid phone or email blocks auto apply and manual-code bypass', async () => {
    const DB = d1Database();
    openDatabases.push(DB.sqlite);
    DB.sqlite.prepare(
      `INSERT INTO orders
        (token, status, phone, email, payment_status, created_at)
       VALUES ('old-paid', 'delivered', '+972500000000', 'NEW@example.com', 'paid', 1)`
    ).run();

    let response = await worker.fetch(
      post('/api/coupons/auto-apply', orderBody),
      envFor(DB),
    );
    assert.deepEqual(await response.json(), { applied: false });

    response = await worker.fetch(
      post('/api/coupons/validate', {
        ...orderBody,
        coupon_code: 'FIRST10-2026',
      }),
      envFor(DB),
    );
    assert.deepEqual(await response.json(), {
      valid: false,
      reason: 'not_new_customer',
      message: 'הטבת המשלוח הראשון אינה זמינה לפרטים האלה',
    });

    response = await worker.fetch(post('/api/orders', orderBody), envFor(DB));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).price, 50);
  });

  test('a private manual coupon replaces rather than stacks with the automatic offer', async () => {
    const DB = d1Database();
    openDatabases.push(DB.sqlite);
    DB.sqlite.prepare(
      `INSERT INTO coupons
        (code, title, value_type, value, status, applies_once_per_customer,
         scope, auto_apply, synced_at)
       VALUES ('MANUAL20', '20% ידני', 'percentage', 20, 'active', 0,
               'delivery', 0, 1)`
    ).run();

    const response = await worker.fetch(
      post('/api/orders', { ...orderBody, coupon_code: 'MANUAL20' }),
      envFor(DB),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.price, 40);
    assert.equal(body.discount_amount, 10);
    assert.equal(body.discount_code, 'MANUAL20');
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM first_delivery_promotion_claims').get().count,
      0,
    );
  });
});
