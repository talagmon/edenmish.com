import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

function quoteDb(ruleEntries = []) {
  const rateLimits = new Map();
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM rate_limits/.test(sql)) return rateLimits.get(this.args[0]) || null;
          return null;
        },
        async all() {
          if (/FROM pricing_rules/.test(sql)) {
            return { results: ruleEntries.map(([name, value]) => ({ name, value })) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO rate_limits/.test(sql)) {
            const [key, count, window_start, last_at, locked_until] = this.args;
            rateLimits.set(key, { count, window_start, last_at, locked_until });
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

const envFor = (db) => ({ DB: db, SESSION_SECRET: 'test-secret' });
const baseQuote = {
  pickup_city: 'תל אביב',
  dropoff_city: 'חולון',
  service: 'standard',
  size: 'small',
  when_date: '2026-07-10',
  when_hour: 12,
};

function postQuote(body, db = quoteDb()) {
  const request = new Request('https://find.edenmish.com/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
    body: JSON.stringify(body),
  });
  return worker.fetch(request, envFor(db));
}

describe('public quote API', () => {
  test('POST uses D1 overrides and returns the complete authoritative breakdown', async () => {
    const db = quoteDb([
      ['std_z2', 79], ['sur_medium', 20], ['sur_evening', 40], ['weekend_mult', 2],
    ]);
    const response = await postQuote({
      ...baseQuote,
      size: 'medium',
      when_date: '2026-07-11',
      when_hour: 19,
    }, db);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      price: 278,
      zone: 2,
      service: 'standard',
      size: 'medium',
      base: 79,
      review: false,
      reasons: [],
      breakdown: {
        base: 79,
        medium_surcharge: 20,
        evening_surcharge: 40,
        weekend_multiplier: 2,
        weekend_surcharge: 139,
        total: 278,
      },
      available: true,
      currency: 'ILS',
    });
  });

  test('GET supports integrations and normalizes query values', async () => {
    const query = new URLSearchParams({
      ...baseQuote,
      pickup_city: 'תל אביב',
      dropoff_city: 'רמת גן',
      service: 'eco',
      when_hour: '12',
    });
    const request = new Request('https://find.edenmish.com/api/quote?' + query, {
      headers: { 'CF-Connecting-IP': '203.0.113.11' },
    });
    const response = await worker.fetch(request, envFor(quoteDb()));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.price, 35);
    assert.equal(body.zone, 1);
    assert.equal(body.available, true);
  });

  test('returns validation errors without inventing a quote', async () => {
    const response = await postQuote({ ...baseQuote, dropoff_city: '' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'missing_cities' });

    const missingHour = await postQuote({ ...baseQuote, when_hour: null });
    assert.equal(missingHour.status, 400);
    assert.deepEqual(await missingHour.json(), { error: 'invalid_schedule' });
  });

  test('returns unavailable route reasons without presenting the fallback as valid', async () => {
    const response = await postQuote({ ...baseQuote, dropoff_city: 'חיפה' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, false);
    assert.equal(body.review, true);
    assert.deepEqual(body.reasons, ['out_of_zone']);
  });

  test('legacy pricing config exposes the canonical Worker zones', async () => {
    const request = new Request('https://find.edenmish.com/api/pricing');
    const response = await worker.fetch(request, envFor(quoteDb()));
    const body = await response.json();
    assert.ok(body.zones['1'].includes('תל אביב'));
    assert.ok(body.zones['3'].includes('פתח תקווה'));
    assert.equal(body.defaults.std_z1, 50);
  });
});
