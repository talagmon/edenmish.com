import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

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
