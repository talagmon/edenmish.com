import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const openDatabases = [];
afterEach(() => {
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
