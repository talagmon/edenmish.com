// Integration-style tests for the coupon API wiring:
//   POST /api/coupons/validate  — happy path, invalid reasons, per-IP rate limit
//   POST /api/orders            — coupon snapshot + redemption / 400 on invalid / unchanged without coupon
//   GET/POST/PUT/DELETE /api/ops/coupons — ops CRUD (D1-only coupon management)
//   createDraftOrder            — coupon orders use final price; no applied_discount
// Run with: npm test (node --test). No real D1/Shopify — both are mocked.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDraftOrder, makeSession } from '../src/integrations.js';

// ---- mocks ----

// D1 stub that covers every table the coupon endpoints and /api/orders touch:
// rate_limits (real counting so throttling behaves), coupons (a live in-memory
// store so the ops CRUD endpoints round-trip: INSERT/UPDATE land and later
// SELECTs see them), coupon_redemptions, orders (INSERT ... RETURNING id,
// token), status_history, notifications, pricing_rules (empty → pricing
// defaults).
// `raceRedemptions: true` simulates a lost TOCTOU race: the COUNT pre-checks
// (validateCoupon) under-report 0 — as if a concurrent order landed between the
// check and the insert — while the conditional INSERT guard sees the real rows.
function apiDb({ coupon = null, raceRedemptions = false, orderRow = null } = {}) {
  const state = { rateLimits: new Map(), coupons: new Map(), orders: [], redemptions: [], runs: [], nextOrderId: 1 };
  if (coupon) state.coupons.set(coupon.code, { ...coupon });
  return {
    state,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM rate_limits/.test(sql)) return state.rateLimits.get(this.args[0]) || null;
          if (/FROM coupons/.test(sql)) return state.coupons.get(this.args[0]) || null;
          if (/FROM coupon_redemptions/.test(sql)) {
            if (raceRedemptions) return { n: 0 };
            const code = this.args[0];
            const byCustomer = /customer_key/.test(sql);
            const n = state.redemptions.filter(r => r.code === code && (!byCustomer || r.customer_key === this.args[1])).length;
            return { n };
          }
          if (/INSERT INTO orders/.test(sql)) {
            const id = state.nextOrderId++;
            state.orders.push({ id, sql, args: this.args });
            return { id, token: this.args[0] };
          }
          if (/SELECT \* FROM orders WHERE id/.test(sql)) return orderRow;
          if (/INSERT INTO notifications/.test(sql)) return { id: 1 };
          return null;
        },
        async all() {
          if (/FROM coupons c/.test(sql)) {
            const results = [...state.coupons.values()].map(c => ({
              ...c,
              redemption_count: state.redemptions.filter(r => r.code === c.code).length,
            }));
            return { results };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO coupons/.test(sql)) {
            const [code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, synced_at] = this.args;
            state.coupons.set(code, { code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, synced_at });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE coupons SET/.test(sql)) {
            const cols = [...sql.split(' WHERE ')[0].matchAll(/(\w+) = \?/g)].map(m => m[1]);
            const row = state.coupons.get(this.args[this.args.length - 1]);
            if (row) cols.forEach((col, i) => { row[col] = this.args[i]; });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (/INSERT INTO rate_limits/.test(sql)) {
            const [key, count, windowStart, lastAt, lockedUntil] = this.args;
            state.rateLimits.set(key, { count, window_start: windowStart, last_at: lastAt, locked_until: lockedUntil });
          }
          if (/INSERT INTO coupon_redemptions/.test(sql)) {
            state.runs.push({ sql, args: this.args });
            const [order_id, code, customer_key, price_before, discount_amount, price_after, created_at] = this.args;
            // Evaluate recordRedemption's conditional guard the way SQLite would.
            let i = 7; // guard binds follow the 7 row values
            let ok = true;
            if (/WHERE code = \?\) < \?/.test(sql)) {
              const [gCode, limit] = [this.args[i], this.args[i + 1]]; i += 2;
              if (state.redemptions.filter(r => r.code === gCode).length >= limit) ok = false;
            }
            if (/customer_key = \?\) = 0/.test(sql)) {
              const [gCode, gKey] = [this.args[i], this.args[i + 1]]; i += 2;
              if (state.redemptions.some(r => r.code === gCode && r.customer_key === gKey)) ok = false;
            }
            if (ok) state.redemptions.push({ order_id, code, customer_key, price_before, discount_amount, price_after, created_at });
            return { meta: { changes: ok ? 1 : 0 } };
          }
          state.runs.push({ sql, args: this.args });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

// A D1 coupon row as the ops dashboard would have created it.
function freshCoupon(overrides = {}) {
  return {
    code: 'SAVE10',
    title: 'Save 10',
    value_type: 'percentage',
    value: 10,
    status: 'active',
    starts_at: null,
    ends_at: null,
    usage_limit: null,
    applies_once_per_customer: 0,
    synced_at: Date.now(),
    ...overrides,
  };
}

// Zone-1 standard order → priceOrder gives ₪50 (std_z1 default), no review flags.
// A 10% coupon takes it to ₪45 (discount ₪5).
const ORDER_BODY = {
  name: 'Test Customer',
  phone: '054-123-4567',
  email: 'Customer@Example.com',
  pickup: 'דיזנגוף 1, תל אביב',
  dropoff: 'ביאליק 2, רמת גן',
  pickup_city: 'תל אביב',
  dropoff_city: 'רמת גן',
  service: 'standard',
  size: 'small',
  when_text: '10:00-12:00 · 12/07',
  when_date: '2026-07-12',
  when_hour: 10,
};

// Distinct IPs per test — the /api/orders per-IP limit (>5 per 10 min) and the
// coupon validate limit (>10 per min) must not bleed across tests.
let ipSeq = 0;
const nextIp = () => `10.0.0.${++ipSeq}`;

function post(path, body, ip) {
  return new Request('https://find.edenmish.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

// No Shopify/SendGrid creds → createCharge returns null, emails are skipped,
// ensureWebhook no-ops. Nothing in these tests touches the network.
const envFor = (db) => ({ DB: db });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// createOrder bind positions (see db.js), including persisted schedule/service fields.
const IDX = { price: 24, subtotal_price: 31, discount_code: 32, discount_amount: 33, discount_title: 34 };

// ---- POST /api/coupons/validate ----

describe('POST /api/coupons/validate', () => {
  test('happy path: computes price server-side and returns the discount', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    const res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: ' save10 ' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.deepEqual(d, {
      valid: true, code: 'SAVE10', subtotal_price: 50, discount_amount: 5, price: 45, title: 'Save 10',
    });
  });

  test('unknown code → not_found with safe Hebrew message', async () => {
    const db = apiDb({ coupon: null });
    const res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'GHOST' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false, reason: 'not_found', message: 'קוד הקופון לא תקף' });
  });

  test('invalid reasons map to their Hebrew messages', async () => {
    const cases = [
      [freshCoupon({ status: 'disabled' }), 'inactive', 'הקופון אינו פעיל'],
      [freshCoupon({ starts_at: Date.now() + 60_000 }), 'not_started', 'הקופון עדיין לא פעיל'],
      [freshCoupon({ ends_at: Date.now() - 1000 }), 'expired', 'פג תוקף הקופון'],
      [freshCoupon({ value_type: 'bogus' }), 'unsupported', 'קוד הקופון לא תקף'],
    ];
    for (const [coupon, reason, message] of cases) {
      const db = apiDb({ coupon });
      const res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(db));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { valid: false, reason, message });
    }
  });

  test('usage_limit_reached and already_used', async () => {
    const limited = apiDb({ coupon: freshCoupon({ usage_limit: 1 }) });
    limited.state.redemptions.push({ order_id: 1, code: 'SAVE10', customer_key: 'x' });
    let res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(limited));
    assert.deepEqual(await res.json(), { valid: false, reason: 'usage_limit_reached', message: 'הקופון מוצה' });

    const once = apiDb({ coupon: freshCoupon({ applies_once_per_customer: 1 }) });
    once.state.redemptions.push({ order_id: 1, code: 'SAVE10', customer_key: '+972541234567' });
    res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(once));
    assert.deepEqual(await res.json(), { valid: false, reason: 'already_used', message: 'הקופון כבר מומש' });
  });

  test('once-per-customer falls back to the email key when no phone is given', async () => {
    // No phone on the request → couponCustomerKey uses the normalized email, so a
    // prior redemption recorded under that email blocks re-use.
    const db = apiDb({ coupon: freshCoupon({ applies_once_per_customer: 1 }) });
    db.state.redemptions.push({ order_id: 1, code: 'SAVE10', customer_key: 'customer@example.com' });
    const { phone, ...noPhone } = ORDER_BODY; // email stays 'Customer@Example.com' → lowercased key
    const res = await worker.fetch(post('/api/coupons/validate', { ...noPhone, coupon_code: 'SAVE10' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false, reason: 'already_used', message: 'הקופון כבר מומש' });
  });

  test('rate limit: 11th attempt from the same IP within a minute → 429', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      const res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'SAVE10' }, ip), envFor(db));
      assert.equal(res.status, 200, `attempt ${i + 1} should pass`);
    }
    const res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'SAVE10' }, ip), envFor(db));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '60');
    const d = await res.json();
    assert.equal(d.valid, false);
    assert.equal(d.reason, 'rate_limited');
    assert.equal(d.message, 'יותר מדי ניסיונות. נסו שוב בעוד דקה');
  });
});

// ---- POST /api/orders with coupon ----

describe('POST /api/orders with coupon', () => {
  test('valid coupon: stores snapshot, discounted price, records redemption', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    const res = await worker.fetch(post('/api/orders', { ...ORDER_BODY, coupon_code: 'save10' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.price, 45);
    assert.equal(d.subtotal_price, 50);
    assert.equal(d.discount_amount, 5);
    assert.equal(d.discount_code, 'SAVE10');

    // Order row snapshot
    assert.equal(db.state.orders.length, 1);
    const inserted = db.state.orders[0];
    const args = inserted.args;
    assert.equal((inserted.sql.match(/\?/g) || []).length, args.length, 'INSERT placeholders must match bound values');
    assert.equal(args[IDX.price], 45);
    assert.equal(args[IDX.subtotal_price], 50);
    assert.equal(args[IDX.discount_code], 'SAVE10');
    assert.equal(args[IDX.discount_amount], 5);
    assert.equal(args[IDX.discount_title], 'Save 10');
    assert.equal(args[16], ORDER_BODY.when_date);
    assert.equal(args[17], ORDER_BODY.when_hour);
    assert.equal(args[18], ORDER_BODY.service);
    assert.equal(args[19], ORDER_BODY.size);

    // Redemption recorded with the order id + phone as customer key (E.164)
    assert.equal(db.state.redemptions.length, 1);
    const r = db.state.redemptions[0];
    assert.equal(r.order_id, 1);
    assert.equal(r.code, 'SAVE10');
    assert.equal(r.customer_key, '+972541234567');
    assert.equal(r.price_before, 50);
    assert.equal(r.discount_amount, 5);
    assert.equal(r.price_after, 45);
  });

  test('lost TOCTOU race: guard insert rejects at usage_limit → 400, snapshot cleared, price restored', async () => {
    // Validation passes (count under-reports 0 — the concurrent racer landed after the
    // check) but the atomic guard sees the limit already consumed and rejects the insert.
    const db = apiDb({ coupon: freshCoupon({ usage_limit: 1 }), raceRedemptions: true });
    db.state.redemptions.push({ order_id: 99, code: 'SAVE10', customer_key: 'someone-else' });
    const res = await worker.fetch(post('/api/orders', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(db));
    assert.equal(res.status, 400);
    const d = await res.json();
    assert.equal(d.error, 'invalid_coupon');
    assert.equal(d.reason, 'usage_limit_reached');
    assert.equal(d.message, 'הקופון מוצה');
    // No second redemption row landed
    assert.equal(db.state.redemptions.length, 1);
    // The already-created order row had its coupon snapshot stripped + full price restored
    const cleanup = db.state.runs.find(c => /UPDATE orders SET price = subtotal_price, subtotal_price = NULL, discount_code = NULL, discount_amount = 0, discount_title = NULL/.test(c.sql));
    assert.ok(cleanup, 'expected the discount-clearing UPDATE on the created order');
    assert.equal(cleanup.args[0], 1); // order id
  });

  test('100% coupon: creates a ₪0 order with the full-price snapshot', async () => {
    const db = apiDb({ coupon: freshCoupon({ value: 100, title: 'Free delivery' }) });
    const res = await worker.fetch(post('/api/orders', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.price, 0);
    assert.equal(d.subtotal_price, 50);
    assert.equal(d.discount_amount, 50);
    const args = db.state.orders[0].args;
    assert.equal(args[IDX.price], 0);
    assert.equal(args[IDX.subtotal_price], 50);
    assert.equal(args[IDX.discount_amount], 50);
    assert.equal(db.state.redemptions.length, 1);
    assert.equal(db.state.redemptions[0].price_after, 0);
  });

  test('invalid coupon: order rejected with 400 + Hebrew message, nothing created', async () => {
    const db = apiDb({ coupon: freshCoupon({ ends_at: Date.now() - 1000 }) });
    const res = await worker.fetch(post('/api/orders', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(db));
    assert.equal(res.status, 400);
    const d = await res.json();
    assert.equal(d.error, 'invalid_coupon');
    assert.equal(d.reason, 'expired');
    assert.equal(d.message, 'פג תוקף הקופון');
    assert.equal(db.state.orders.length, 0, 'no order row created');
    assert.equal(db.state.redemptions.length, 0, 'no redemption recorded');
  });

  test('no coupon_code: full price, empty snapshot, no redemption, no discount keys in response', async () => {
    const db = apiDb();
    const res = await worker.fetch(post('/api/orders', { ...ORDER_BODY }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.price, 50);
    assert.ok(!('subtotal_price' in d), 'no subtotal_price key without a coupon');
    assert.ok(!('discount_amount' in d), 'no discount_amount key without a coupon');
    assert.ok(!('discount_code' in d), 'no discount_code key without a coupon');

    const args = db.state.orders[0].args;
    assert.equal(args[IDX.price], 50);
    assert.equal(args[IDX.subtotal_price], null);
    assert.equal(args[IDX.discount_code], null);
    assert.equal(args[IDX.discount_amount], 0);
    assert.equal(args[IDX.discount_title], null);
    assert.equal(db.state.redemptions.length, 0);
  });
});

// ---- ops coupon CRUD: GET/POST/PUT/DELETE /api/ops/coupons ----

describe('ops coupon CRUD endpoints', () => {
  // Session-authenticated ops request (SESSION_SECRET defaults to 'dev' on both sides).
  async function opsReq(method, path, body) {
    const session = await makeSession({});
    return new Request('https://find.edenmish.com' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Ops': session },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  test('all four endpoints reject requests without an ops session (401)', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    const reqs = [
      new Request('https://find.edenmish.com/api/ops/coupons'),
      new Request('https://find.edenmish.com/api/ops/coupons', { method: 'POST', body: '{}' }),
      new Request('https://find.edenmish.com/api/ops/coupons/SAVE10', { method: 'PUT', body: '{}' }),
      new Request('https://find.edenmish.com/api/ops/coupons/SAVE10', { method: 'DELETE' }),
    ];
    for (const req of reqs) {
      const res = await worker.fetch(req, envFor(db));
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
    }
    assert.ok(db.state.coupons.has('SAVE10'), 'nothing was modified');
  });

  test('POST creates a coupon; GET lists it with redemption_count', async () => {
    const db = apiDb();
    let res = await worker.fetch(await opsReq('POST', '/api/ops/coupons', {
      code: ' new15 ', title: '15% off', value_type: 'percentage', value: 15,
    }), envFor(db));
    assert.equal(res.status, 200);
    const created = await res.json();
    assert.equal(created.ok, true);
    assert.equal(created.coupon.code, 'NEW15'); // normalized uppercase
    assert.equal(created.coupon.status, 'active');

    db.state.redemptions.push({ order_id: 1, code: 'NEW15', customer_key: 'x' });
    res = await worker.fetch(await opsReq('GET', '/api/ops/coupons'), envFor(db));
    assert.equal(res.status, 200);
    const { coupons } = await res.json();
    assert.equal(coupons.length, 1);
    assert.equal(coupons[0].code, 'NEW15');
    assert.equal(coupons[0].redemption_count, 1);
  });

  test('POST with missing fields → 400; duplicate code → 409', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    let res = await worker.fetch(await opsReq('POST', '/api/ops/coupons', { code: 'X', value_type: 'percentage' }), envFor(db));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'missing fields' });

    res = await worker.fetch(await opsReq('POST', '/api/ops/coupons', {
      code: 'save10', title: 'dup', value_type: 'percentage', value: 5,
    }), envFor(db));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'code already exists' });
    assert.equal(db.state.coupons.get('SAVE10').value, 10, 'existing row untouched');
  });

  test('PUT updates fields on an existing coupon; unknown code → 404', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    let res = await worker.fetch(await opsReq('PUT', '/api/ops/coupons/save10', { value: 25, usage_limit: 3 }), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.equal(d.coupon.value, 25);
    assert.equal(d.coupon.usage_limit, 3);
    assert.equal(d.coupon.title, 'Save 10', 'untouched field preserved');

    res = await worker.fetch(await opsReq('PUT', '/api/ops/coupons/GHOST', { value: 1 }), envFor(db));
    assert.equal(res.status, 404);
  });

  test('DELETE soft-deletes: status → inactive, row kept, code stops validating', async () => {
    const db = apiDb({ coupon: freshCoupon() });
    let res = await worker.fetch(await opsReq('DELETE', '/api/ops/coupons/SAVE10'), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.equal(d.coupon.status, 'inactive');
    assert.ok(db.state.coupons.has('SAVE10'), 'row not removed from D1');

    // The public validate endpoint now rejects it.
    res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'SAVE10' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false, reason: 'inactive', message: 'הקופון אינו פעיל' });

    res = await worker.fetch(await opsReq('DELETE', '/api/ops/coupons/GHOST'), envFor(db));
    assert.equal(res.status, 404);
  });

  test('D1-only end-to-end: ops-created coupon is instantly redeemable on the funnel', async () => {
    const db = apiDb();
    let res = await worker.fetch(await opsReq('POST', '/api/ops/coupons', {
      code: 'LAUNCH', title: 'Launch', value_type: 'fixed_amount', value: 20,
    }), envFor(db));
    assert.equal(res.status, 200);

    // No sync/TTL: the very next validate call sees the new code.
    res = await worker.fetch(post('/api/coupons/validate', { ...ORDER_BODY, coupon_code: 'launch' }, nextIp()), envFor(db));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      valid: true, code: 'LAUNCH', subtotal_price: 50, discount_amount: 20, price: 30, title: 'Launch',
    });
  });
});

// ---- createDraftOrder: coupon orders inflate to subtotal + applied_discount ----
// When a coupon was applied, the line item keeps the original subtotal and the
// discount is attached as a Shopify applied_discount (fixed_amount) so the checkout
// invoice shows the discount breakdown to the customer.

describe('createDraftOrder coupon pricing', () => {
  const SHOPIFY_ENV = { SHOPIFY_SHOP: 'test.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_test' };

  function captureDraftFetch() {
    const captured = {};
    globalThis.fetch = async (url, opts) => {
      captured.body = JSON.parse(opts.body);
      return { ok: true, async json() { return { draft_order: { id: 99, invoice_url: 'https://test.myshopify.com/invoice' } }; } };
    };
    return captured;
  }

  const baseOrder = {
    token: 'tok123', pickup: 'א', dropoff: 'ב',
    service: 'standard', size: 'small', phone: '+972541234567',
  };

  test('coupon order: line item at subtotal, applied_discount for the difference', async () => {
    const captured = captureDraftFetch();
    const order = { ...baseOrder, price: 45, subtotal_price: 50, discount_code: 'SAVE10', discount_amount: 5, discount_title: 'Save 10' };
    const draft = await createDraftOrder(SHOPIFY_ENV, order, 45);
    assert.ok(draft);
    const d = captured.body.draft_order;
    assert.equal(d.line_items[0].price, '50.00');
    assert.ok('applied_discount' in d);
    assert.equal(d.applied_discount.title, 'SAVE10');
    assert.equal(d.applied_discount.value_type, 'fixed_amount');
    assert.equal(d.applied_discount.amount, '5.00');
  });

  test('percentage coupon: line item at subtotal with applied_discount', async () => {
    const captured = captureDraftFetch();
    const order = { ...baseOrder, price: 76, subtotal_price: 85, discount_code: 'SAVE10', discount_amount: 9 };
    await createDraftOrder(SHOPIFY_ENV, order, 76);
    const d = captured.body.draft_order;
    assert.equal(d.line_items[0].price, '85.00');
    assert.equal(d.applied_discount.amount, '9.00');
  });

  test('100% coupon: line item at subtotal, applied_discount covers the full amount', async () => {
    const captured = captureDraftFetch();
    const order = { ...baseOrder, price: 0, subtotal_price: 50, discount_code: 'FREE100', discount_amount: 50, discount_title: 'Free delivery' };
    await createDraftOrder(SHOPIFY_ENV, order, 0);
    const d = captured.body.draft_order;
    assert.equal(d.line_items[0].price, '50.00');
    assert.equal(d.applied_discount.amount, '50.00');
  });

  test('non-coupon order: line item is the plain price, no applied_discount', async () => {
    const captured = captureDraftFetch();
    await createDraftOrder(SHOPIFY_ENV, { ...baseOrder, price: 50 }, 50);
    const d = captured.body.draft_order;
    assert.equal(d.line_items[0].price, '50.00');
    assert.ok(!('applied_discount' in d), 'no applied_discount for non-coupon orders');
  });
});

// ---- ops /approve: manual re-price supersedes the coupon ----

describe('POST /api/ops/orders/:id/approve on a couponed order', () => {
  test('clears the coupon snapshot and deletes the redemption row', async () => {
    const orderRow = {
      id: 5, token: 'tok123', status: 'review', price: 45,
      subtotal_price: 50, discount_code: 'SAVE10', discount_amount: 5, discount_title: 'Save 10',
      pickup: 'א', dropoff: 'ב', email: null,
    };
    const db = apiDb({ orderRow });
    const session = await makeSession({}); // SESSION_SECRET defaults to 'dev' on both sides
    const res = await worker.fetch(new Request('https://find.edenmish.com/api/ops/orders/5/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ops': session },
      body: JSON.stringify({ price: 60 }),
    }), envFor(db));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    const clear = db.state.runs.find(c => /UPDATE orders SET subtotal_price=NULL, discount_code=NULL, discount_amount=0, discount_title=NULL/.test(c.sql));
    assert.ok(clear, 'expected the coupon-snapshot-clearing UPDATE');
    assert.deepEqual(clear.args, [5]);

    const del = db.state.runs.find(c => /DELETE FROM coupon_redemptions WHERE order_id=\?/.test(c.sql));
    assert.ok(del, 'expected the redemption row to be freed');
    assert.deepEqual(del.args, [5]);

    // No Shopify creds → fallback branch re-prices to the manual amount
    const reprice = db.state.runs.find(c => /UPDATE orders SET price=\?, review_flag=0/.test(c.sql));
    assert.ok(reprice, 'expected the re-price UPDATE');
    assert.equal(reprice.args[0], 60);
  });
});
