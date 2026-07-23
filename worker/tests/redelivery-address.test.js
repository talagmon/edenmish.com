import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeSession } from '../src/integrations.js';

// A held order awaiting a corrected redelivery address, keyed by tracking token.
function redeliveryDb(order) {
  const state = { updated: null };
  return {
    state,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args) {
          return {
            async first() {
              if (s.startsWith('SELECT * FROM orders WHERE LOWER(token)')) return order;
              return null;
            },
            async run() {
              if (s.startsWith('UPDATE orders SET pending_redelivery_json')) {
                state.updated = { json: args[0], id: args[1] };
              }
              return { meta: { changes: 1 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

function request(token, body) {
  return new Request(`https://find.edenmish.com/api/orders/${token}/redelivery-address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const held = {
  id: 9001,
  token: 'trk_abc',
  status: 'failed',
  retained_by_driver: 'hold_for_redelivery',
  email_verified: 1, // OTP cleared: an address change is a sensitive write
  pickup_city: 'תל אביב',
  when_date: null,
  when_hour: null,
};
const newAddress = {
  dropoff: 'ויצמן 14',
  dropoff_city: 'גבעתיים',
  dropoff_lat: 32.07,
  dropoff_lng: 34.81,
};

describe('POST /api/orders/:token/redelivery-address', () => {
  test('stages the corrected address and returns the zone-derived fee, without dispatching', async () => {
    const db = redeliveryDb(held);
    const res = await worker.fetch(request('trk_abc', newAddress), { DB: db });
    const data = await res.json();

    assert.equal(res.status, 200);
    // Givatayim is Zone 1, so the fee is the Zone 1 retry rate.
    assert.equal(data.fee, 25);
    assert.equal(data.zone, 1);

    // The address is staged, not written onto the live dropoff columns, and nothing about the
    // order status or custody changes here — dispatch happens only after payment.
    assert.ok(db.state.updated, 'expected the pending address to be staged');
    const staged = JSON.parse(db.state.updated.json);
    assert.equal(staged.dropoff_city, 'גבעתיים');
    assert.equal(staged.fee, 25);
    assert.ok(staged.submitted_at > 0);
  });

  test('requires OTP verification before an address change is accepted', async () => {
    const unverified = { ...held, email_verified: 0 };
    const db = redeliveryDb(unverified);
    const res = await worker.fetch(request('trk_abc', newAddress), { DB: db });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'otp_required');
    assert.equal(db.state.updated, null, 'an unverified caller must not stage an address');
  });

  test('rejects an order that is not awaiting redelivery', async () => {
    const notHeld = { ...held, retained_by_driver: null };
    const res = await worker.fetch(request('trk_abc', newAddress), { DB: redeliveryDb(notHeld) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'not_awaiting_redelivery');
  });

  test('requires routable coordinates so a driver is never sent to an unnavigable pin', async () => {
    const db = redeliveryDb(held);
    const res = await worker.fetch(
      request('trk_abc', { dropoff: 'ויצמן 14', dropoff_city: 'גבעתיים' }),
      { DB: db },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_coordinates');
    assert.equal(db.state.updated, null);
  });

  test('rejects a destination outside the served zones', async () => {
    const db = redeliveryDb(held);
    const res = await worker.fetch(
      request('trk_abc', { ...newAddress, dropoff_city: 'אילת' }),
      { DB: db },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'out_of_zone');
    assert.equal(db.state.updated, null);
  });

  test('an unknown token is not found', async () => {
    const res = await worker.fetch(request('nope', newAddress), { DB: redeliveryDb(null) });
    assert.equal(res.status, 404);
  });
});

// ---- Ops release of a paid redelivery ----
function releaseDb(order, chargeStatus = 'paid') {
  const state = {
    released: null,
    charge: chargeStatus ? { id: 'rdl_test', order_id: order?.id, status: chargeStatus } : null,
  };
  const DB = {
    state,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (s.startsWith('SELECT * FROM orders WHERE id')) return order;
          if (s.startsWith('SELECT * FROM redelivery_charges WHERE order_id')) return state.charge;
          return null;
        },
        async run() {
          if (s.startsWith('UPDATE orders SET dropoff')) {
            state.released = { sql: s, args: this.args };
            order.retained_by_driver = 'redelivery';
          }
          if (s.startsWith('UPDATE redelivery_charges SET status')) state.charge.status = 'released';
          return { meta: { changes: 1 } };
        },
        async all() { return { results: [] }; },
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return DB;
}

async function opsRequest(id) {
  const session = await makeSession({ SESSION_SECRET: 'test-secret' });
  return new Request(`https://ops.edenmish.com/api/ops/orders/${id}/release-redelivery`, {
    method: 'POST',
    headers: { 'X-Ops': session },
  });
}
const opsEnv = (db) => ({ DB: db, SESSION_SECRET: 'test-secret' });

describe('POST /api/ops/orders/:id/release-redelivery', () => {
  const staged = {
    id: 9001,
    status: 'failed',
    retained_by_driver: 'hold_for_redelivery',
    pending_redelivery_json: JSON.stringify({
      dropoff: 'ויצמן 14', dropoff_detail: 'דירה 3', dropoff_lat: 32.07, dropoff_lng: 34.81,
      dropoff_city: 'גבעתיים', zone: 1, fee: 25, submitted_at: 1,
    }),
  };

  test('promotes the staged address to the live destination and marks it a redelivery', async () => {
    const db = releaseDb({ ...staged });
    const res = await worker.fetch(await opsRequest(9001), opsEnv(db));

    assert.equal(res.status, 200);
    assert.ok(db.state.released, 'expected the corrected address to be promoted');
    assert.match(db.state.released.sql, /retained_by_driver = 'redelivery'/);
    assert.match(db.state.released.sql, /pending_redelivery_json = NULL/);
    assert.ok(db.state.released.args.includes('גבעתיים'));
  });

  test('refuses to release an order that is not awaiting redelivery', async () => {
    const notStaged = { id: 9001, status: 'failed', retained_by_driver: 'return_to_origin', pending_redelivery_json: null };
    const db = releaseDb(notStaged);
    const res = await worker.fetch(await opsRequest(9001), opsEnv(db));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'not_awaiting_redelivery');
    assert.equal(db.state.released, null);
  });

  test('refuses to release a corrected address before Shopify payment is verified', async () => {
    const db = releaseDb({ ...staged }, 'link_sent');
    const res = await worker.fetch(await opsRequest(9001), opsEnv(db));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'redelivery_payment_required');
    assert.equal(db.state.released, null);
  });

  test('is idempotent once already released', async () => {
    const already = { id: 9001, status: 'failed', retained_by_driver: 'redelivery' };
    const res = await worker.fetch(await opsRequest(9001), opsEnv(releaseDb(already)));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).already, true);
  });

  test('rejects an unauthenticated caller', async () => {
    const req = new Request('https://ops.edenmish.com/api/ops/orders/9001/release-redelivery', { method: 'POST' });
    const res = await worker.fetch(req, opsEnv(releaseDb({ ...staged })));
    assert.equal(res.status, 401);
  });
});
