import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDriverGpsSamples,
  addGps,
  createOrder,
  getGpsTrail,
} from '../src/db.js';

function captureDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      return {
        bind(...args) { call.args = args; return this; },
        async first() { return { id: 42, token: call.args[0] }; },
        async run() { return { meta: { changes: 1 } }; },
        async all() { return { results: [{ lat: 32.1, lng: 34.8, at: 123 }] }; },
      };
    },
  };
}

describe('order persistence', () => {
  test('stores service, size, and schedule fields with aligned SQL bindings', async () => {
    const db = captureDb();
    await createOrder(db, {
      status: 'priced',
      name: 'Test',
      phone: '+972541234567',
      pickup: 'Pickup',
      dropoff: 'Dropoff',
      when_text: '10:00-12:00',
      when_date: '2026-07-12',
      when_hour: 10,
      service: 'standard',
      size: 'medium',
      price: 65,
      phone_delivery_link_opt_in: true,
      phone_delivery_link_opt_in_at: 1_721_000_000_000,
    });

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO orders'));
    assert.ok(insert);
    assert.equal((insert.sql.match(/\?/g) || []).length, insert.args.length);
    assert.equal(insert.args[16], '2026-07-12');
    assert.equal(insert.args[17], 10);
    assert.equal(insert.args[18], 'standard');
    assert.equal(insert.args[19], 'medium');
    assert.equal(insert.args.at(-2), 1);
    assert.equal(insert.args.at(-1), 1_721_000_000_000);
  });
});

describe('GPS retention', () => {
  test('prunes old pings after insertion and bounds trail reads', async () => {
    const db = captureDb();
    await addGps(db, 42, 32.1, 34.8);
    const trail = await getGpsTrail(db, 42, 5000);

    assert.ok(db.calls.some((call) => call.sql.includes('INSERT INTO gps_pings')));
    const prune = db.calls.find((call) => call.sql.includes('DELETE FROM gps_pings'));
    assert.ok(prune);
    assert.deepEqual(prune.args, [42, 42]);

    const read = db.calls.find((call) => call.sql.includes('SELECT lat, lng, at FROM ('));
    assert.ok(read);
    assert.deepEqual(read.args, [42, 1000]);
    assert.equal(trail.length, 1);
  });

  test('mirrors native samples idempotently with their captured timestamps', async () => {
    const db = captureDb();
    const inserted = await addDriverGpsSamples(db, 42, [{
      lat: 32.0809,
      lng: 34.7806,
      at: 1_790_000_000_000,
    }]);

    assert.equal(inserted, 1);
    const write = db.calls.find((call) => call.sql.includes('WHERE NOT EXISTS'));
    assert.ok(write);
    assert.deepEqual(write.args, [
      42, 32.0809, 34.7806, 1_790_000_000_000,
      42, 32.0809, 34.7806, 1_790_000_000_000,
    ]);
    const prune = db.calls.at(-1);
    assert.match(prune.sql, /DELETE FROM gps_pings/);
    assert.deepEqual(prune.args, [42, 42]);
  });
});
