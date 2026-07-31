import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';
import { makeSession } from '../src/integrations.js';
import {
  isStaleCheckoutOrphan,
  STALE_CHECKOUT_ORPHAN_AGE_MS,
} from '../src/coupons.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const openDatabases = [];

afterEach(() => {
  while (openDatabases.length) openDatabases.pop().close();
});

function d1Database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  openDatabases.push(sqlite);
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

function insertOrder(sqlite, {
  id,
  createdAt,
  paymentUrl = null,
  paymentId = null,
  draftOrderId = null,
  shopifyOrderId = null,
  paymentStatus = 'none',
  status = 'priced',
}) {
  sqlite.prepare(
    `INSERT INTO orders (
       id, token, status, price, payment_status, payment_url, payment_id,
       shopify_draft_order_id, shopify_order_id, created_at
     ) VALUES (?, ?, ?, 45, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `stale-order-${id}`,
    status,
    paymentStatus,
    paymentUrl,
    paymentId,
    draftOrderId,
    shopifyOrderId,
    createdAt,
  );
}

async function opsRequest(path, method = 'POST') {
  const session = await makeSession({ SESSION_SECRET: 'stale-checkout-test-secret' });
  return new Request(`https://ops.edenmish.com${path}`, {
    method,
    headers: { 'X-Ops': session },
  });
}

const envFor = (DB) => ({
  DB,
  SESSION_SECRET: 'stale-checkout-test-secret',
});

describe('stale checkout orphan recovery', () => {
  test('classifies only aged, artifact-free priced orders as recoverable', () => {
    const now = 2_000_000_000_000;
    const staleCreatedAt = now - STALE_CHECKOUT_ORPHAN_AGE_MS - 1;
    const base = {
      status: 'priced',
      payment_status: 'none',
      created_at: staleCreatedAt,
      has_payment_record: 0,
    };

    assert.equal(isStaleCheckoutOrphan(base, { now }), true);
    assert.equal(isStaleCheckoutOrphan({ ...base, created_at: now - 1_000 }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, payment_url: 'https://pay.example' }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, shopify_draft_order_id: '123' }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, shopify_order_id: '456' }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, payment_id: 'payment-1' }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, invoice_url: 'https://invoice.example' }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, has_payment_record: 1 }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, payment_status: 'link_sent' }, { now }), false);
    assert.equal(isStaleCheckoutOrphan({ ...base, status: 'payment_sent' }, { now }), false);
  });

  test('cancels an orphan and atomically releases its coupon and promotion claim', async () => {
    const DB = d1Database();
    const createdAt = Date.now() - STALE_CHECKOUT_ORPHAN_AGE_MS - 10_000;
    insertOrder(DB.sqlite, { id: 41, createdAt });
    DB.sqlite.prepare(
      `INSERT INTO first_delivery_promotion_claims (
         id, coupon_code, customer_key, phone_key, order_id, status, created_at, updated_at
       ) VALUES (7, 'FIRST10-2026', 'customer-41', '+972541234567', 41, 'redeemed', ?, ?)`
    ).run(createdAt, createdAt);
    DB.sqlite.prepare(
      `INSERT INTO coupon_redemptions (
         order_id, code, customer_key, price_before, discount_amount,
         price_after, created_at, promotion_claim_id
       ) VALUES (41, 'FIRST10-2026', 'customer-41', 50, 5, 45, ?, 7)`
    ).run(createdAt);

    const response = await worker.fetch(
      await opsRequest('/api/ops/orders/41/recover-checkout'),
      envFor(DB),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      released_coupon_redemptions: 1,
      released_promotion_claims: 1,
    });
    assert.deepEqual({
      ...DB.sqlite.prepare(
        'SELECT status, payment_status, review_reason FROM orders WHERE id = 41'
      ).get(),
    }, {
      status: 'cancelled',
      payment_status: 'checkout_failed',
      review_reason: 'stale_checkout_recovered',
    });
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM coupon_redemptions WHERE order_id = 41').get().count,
      0,
    );
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM first_delivery_promotion_claims WHERE order_id = 41').get().count,
      0,
    );
    assert.equal(
      DB.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM status_history
         WHERE order_id = 41 AND status = 'cancelled'
           AND note = 'stale_checkout_recovered'`
      ).get().count,
      1,
    );

    const retry = await worker.fetch(
      await opsRequest('/api/ops/orders/41/recover-checkout'),
      envFor(DB),
    );
    assert.equal(retry.status, 409);
    assert.equal(
      DB.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM status_history
         WHERE order_id = 41 AND note = 'stale_checkout_recovered'`
      ).get().count,
      1,
    );
  });

  test('rejects fresh orders and orders with any payment evidence without changing benefits', async () => {
    const DB = d1Database();
    const staleCreatedAt = Date.now() - STALE_CHECKOUT_ORPHAN_AGE_MS - 10_000;
    insertOrder(DB.sqlite, { id: 51, createdAt: Date.now() });
    insertOrder(DB.sqlite, {
      id: 52,
      createdAt: staleCreatedAt,
      paymentUrl: 'https://checkout.example/52',
      draftOrderId: 'draft-52',
    });
    insertOrder(DB.sqlite, { id: 53, createdAt: staleCreatedAt });
    DB.sqlite.prepare(
      `INSERT INTO payments (order_id, amount, status, url, created_at)
       VALUES (53, 4500, 'created', NULL, ?)`
    ).run(staleCreatedAt);
    DB.sqlite.prepare(
      `INSERT INTO coupon_redemptions (
         order_id, code, customer_key, price_before, discount_amount, price_after, created_at
       ) VALUES (51, 'FIRST10-2026', 'fresh', 50, 5, 45, ?)`
    ).run(staleCreatedAt);

    for (const id of [51, 52, 53]) {
      const response = await worker.fetch(
        await opsRequest(`/api/ops/orders/${id}/recover-checkout`),
        envFor(DB),
      );
      assert.equal(response.status, 409);
      assert.equal(
        DB.sqlite.prepare('SELECT status FROM orders WHERE id = ?').get(id).status,
        'priced',
      );
    }
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM coupon_redemptions WHERE order_id = 51').get().count,
      1,
    );
  });

  test('requires an authenticated Ops session', async () => {
    const DB = d1Database();
    insertOrder(DB.sqlite, {
      id: 61,
      createdAt: Date.now() - STALE_CHECKOUT_ORPHAN_AGE_MS - 10_000,
    });

    const response = await worker.fetch(
      new Request('https://ops.edenmish.com/api/ops/orders/61/recover-checkout', {
        method: 'POST',
      }),
      envFor(DB),
    );

    assert.equal(response.status, 401);
    assert.equal(DB.sqlite.prepare('SELECT status FROM orders WHERE id = 61').get().status, 'priced');
  });

  test('rejects a cookie-authenticated cross-origin mutation', async () => {
    const DB = d1Database();
    insertOrder(DB.sqlite, {
      id: 62,
      createdAt: Date.now() - STALE_CHECKOUT_ORPHAN_AGE_MS - 10_000,
    });
    const session = await makeSession({ SESSION_SECRET: 'stale-checkout-test-secret' });

    const response = await worker.fetch(
      new Request('https://ops.edenmish.com/api/ops/orders/62/recover-checkout', {
        method: 'POST',
        headers: {
          Cookie: `ops_sess=${session}`,
          Origin: 'https://attacker.example',
        },
      }),
      envFor(DB),
    );

    assert.equal(response.status, 403);
    assert.equal(DB.sqlite.prepare('SELECT status FROM orders WHERE id = 62').get().status, 'priced');
  });

  test('marks eligible orders in the Ops list without marking payment-backed orders', async () => {
    const DB = d1Database();
    const staleCreatedAt = Date.now() - STALE_CHECKOUT_ORPHAN_AGE_MS - 10_000;
    insertOrder(DB.sqlite, { id: 71, createdAt: staleCreatedAt });
    insertOrder(DB.sqlite, { id: 72, createdAt: staleCreatedAt });
    DB.sqlite.prepare(
      `INSERT INTO payments (order_id, amount, status, url, created_at)
       VALUES (72, 4500, 'created', NULL, ?)`
    ).run(staleCreatedAt);

    const response = await worker.fetch(
      await opsRequest('/api/ops/orders', 'GET'),
      envFor(DB),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    const byId = new Map(body.orders.map((order) => [order.id, order]));
    assert.equal(byId.get(71).checkout_recovery_eligible, true);
    assert.equal(byId.get(72).checkout_recovery_eligible, false);
    assert.equal('has_payment_record' in byId.get(71), false);
  });
});
