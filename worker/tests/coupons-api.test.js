// Integration-style tests for the coupon API wiring:
//   POST /api/coupons/validate  — happy path, invalid reasons, per-IP rate limit
//   POST /api/orders            — coupon snapshot + redemption / 400 on invalid / unchanged without coupon
//   GET/POST/PUT/DELETE /api/ops/coupons — ops CRUD (D1-only coupon management)
//   createDraftOrder            — coupon orders use subtotal + appliedDiscount
// Run with: npm test (node --test). No real D1/Shopify — both are mocked.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDraftOrder, hashOtp, makeSession } from '../src/integrations.js';

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
  const state = {
    rateLimits: new Map(),
    coupons: new Map(),
    orders: [],
    redemptions: [],
    runs: [],
    outboxKeys: new Set(),
    nextOrderId: 1,
  };
  if (coupon) state.coupons.set(coupon.code, { ...coupon });
  return {
    state,
    prepare(sql) {
      return {
        sql,
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
          if (/SELECT \* FROM orders WHERE shopify_order_id/.test(sql)) {
            return orderRow && String(orderRow.shopify_order_id) === String(this.args[0]) ? orderRow : null;
          }
          if (/SELECT \* FROM orders WHERE LOWER\(token\)/.test(sql)) return orderRow;
          if (/INSERT INTO notifications/.test(sql)) {
            state.runs.push({ sql, args: this.args });
            return { id: state.runs.length };
          }
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
          if (/INSERT OR IGNORE INTO delivery_notification_outbox/.test(sql)) {
            const key = `${this.args[0]}:payment_received:whatsapp:${this.args[2]}`;
            if (state.outboxKeys.has(key)) return { meta: { changes: 0 } };
            state.outboxKeys.add(key);
            state.runs.push({ sql, args: this.args });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE orders\s+SET status = 'delivered'/.test(sql) && orderRow) {
            orderRow.status = 'delivered';
            orderRow.delivered_at = this.args[0];
            orderRow.payment_status = this.args[1];
          }
          if (/UPDATE orders\s+SET status = \?/.test(sql) && orderRow) {
            orderRow.status = this.args[0];
            const columns = [...sql.matchAll(/(\w+) = \?/g)].map(m => m[1]);
            columns.forEach((column, index) => { orderRow[column] = this.args[index]; });
          }
          if (/INSERT INTO coupons/.test(sql)) {
            const [code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, scope, business_plan_ids, synced_at] = this.args;
            state.coupons.set(code, { code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, scope, business_plan_ids, synced_at });
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
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
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

async function opsPost(path, body) {
  const session = await makeSession({ SESSION_SECRET: 'test-secret' });
  return new Request('https://ops.edenmish.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ops': session },
    body: JSON.stringify(body),
  });
}

async function shopifyWebhook(body, secret = 'webhook-secret', topic = 'orders/paid') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hmac = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return new Request('https://find.edenmish.com/webhooks/shopify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-SHA256': hmac, 'X-Shopify-Topic': topic }, body: raw,
  });
}

// No Shopify/SendGrid creds → createCharge returns null, emails are skipped,
// ensureWebhook no-ops. Nothing in these tests touches the network.
const envFor = (db) => ({ DB: db, SESSION_SECRET: 'test-secret' });

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

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
    assert.equal(d.order_id, 1);
    assert.ok(!('token' in d), 'unpaid response must not expose a tracking token');
    assert.ok(!('tracking_url' in d), 'unpaid response must not expose a tracking URL');
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

  test('exact-price order returns checkout plus a status-only confirmation capability', async () => {
    const db = apiDb();
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).endsWith('/webhooks.json')) {
        if (!opts.method) {
          return { ok: true, async json() { return { webhooks: [{ topic: 'orders/paid', address: 'https://find.edenmish.com/webhooks/shopify' }] }; } };
        }
        const webhook = JSON.parse(opts.body).webhook;
        assert.ok(['orders/updated', 'refunds/create'].includes(webhook.topic));
        return { ok: true, async json() { return { webhook: { id: webhook.topic, ...webhook } }; } };
      }
      assert.ok(String(url).endsWith('/graphql.json'));
      assert.equal(opts.method, 'POST');
      return { ok: true, async json() { return { data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/99', legacyResourceId: '99', invoiceUrl: 'https://test.myshopify.com/invoice/abc' }, userErrors: [] } } }; } };
    };
    const env = { ...envFor(db), SHOPIFY_SHOP: 'test.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_test' };
    const res = await worker.fetch(post('/api/orders', { ...ORDER_BODY }, nextIp()), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.order_id, 1);
    assert.equal(d.status, 'payment_sent');
    assert.equal(d.payment_url, 'https://test.myshopify.com/invoice/abc?locale=he');
    assert.match(d.payment_confirmation_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!('token' in d));
    assert.ok(!('tracking_url' in d));
  });

  test('rejects unsupported enums and oversized public input before insertion', async () => {
    for (const body of [
      { ...ORDER_BODY, service: 'teleport' },
      { ...ORDER_BODY, name: 'x'.repeat(121) },
      { ...ORDER_BODY, pickup_lat: 200, pickup_lng: 34.8 },
    ]) {
      const db = apiDb();
      const res = await worker.fetch(post('/api/orders', body, nextIp()), envFor(db));
      assert.equal(res.status, 400);
      assert.equal(db.state.orders.length, 0);
    }
  });

  test('rejects a mistyped email domain before creating an order', async () => {
    const db = apiDb();
    const res = await worker.fetch(
      post('/api/orders', { ...ORDER_BODY, email: 'customer@gmail.con' }, nextIp()),
      envFor(db),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'invalid_email_domain',
      suggestion: 'customer@gmail.com',
    });
    assert.equal(db.state.orders.length, 0);
  });
});

describe('customer tracking payment gate', () => {
  test('blocks an unpaid tracking token without revealing order data', async () => {
    const token = 'unpaidtrackingtoken12345';
    const db = apiDb({ orderRow: { id: 31, token, status: 'payment_sent', payment_status: 'link_sent' } });
    const res = await worker.fetch(new Request(`https://find.edenmish.com/api/orders/${token}`), envFor(db));
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { error: 'payment_required' });
  });

  test('allows tracking after payment confirmation', async () => {
    const token = 'paidtrackingtoken123456';
    const db = apiDb({ orderRow: { id: 32, token, status: 'paid', payment_status: 'paid', delivered_at: null } });
    const res = await worker.fetch(new Request(`https://find.edenmish.com/api/orders/${token}`), envFor(db));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.order.id, 32);
    assert.equal(d.otp_pending, false);
  });

  test('keeps a cancelled wallet order visible after its reservation is released', async () => {
    const token = 'cancelledwallettrack1';
    const db = apiDb({ orderRow: {
      id: 33,
      token,
      status: 'cancelled',
      payment_status: 'wallet_released',
      payment_method: 'wallet',
      delivered_at: null,
    } });
    const res = await worker.fetch(new Request(`https://find.edenmish.com/api/orders/${token}`), envFor(db));

    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.order.id, 33);
    assert.equal(d.order.status, 'cancelled');
    assert.equal(d.order.payment_status, 'wallet_released');
    assert.equal(d.otp_pending, false);
  });
});

// ---- ops coupon CRUD: GET/POST/PUT/DELETE /api/ops/coupons ----

describe('ops coupon CRUD endpoints', () => {
  // Session-authenticated ops request using an explicit test-only secret.
  async function opsReq(method, path, body) {
    const session = await makeSession({ SESSION_SECRET: 'test-secret' });
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

// ---- createDraftOrder: checkout contact + coupon pricing payload ----
// When a coupon was applied, the line item keeps the original subtotal and the
// discount is attached as a Shopify applied_discount (fixed_amount) so the checkout
// invoice shows the discount breakdown to the customer.

describe('createDraftOrder Shopify payload', () => {
  const SHOPIFY_ENV = { SHOPIFY_SHOP: 'test.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_test' };

  function captureDraftFetch() {
    const captured = {};
    globalThis.fetch = async (url, opts) => {
      captured.url = String(url);
      captured.body = JSON.parse(opts.body);
      return { ok: true, async json() { return { data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/99', legacyResourceId: '99', invoiceUrl: 'https://test.myshopify.com/invoice' }, userErrors: [] } } }; } };
    };
    return captured;
  }

  const baseOrder = {
    token: 'tok123', pickup: 'א', dropoff: 'ב',
    service: 'standard', size: 'small', phone: '+972541234567',
    email: 'booking@example.com', email_verified: 0,
  };

  test('includes the booking email before tracking OTP verification', async () => {
    const captured = captureDraftFetch();
    await createDraftOrder(SHOPIFY_ENV, baseOrder, 50);
    const d = captured.body.variables.input;
    assert.equal(d.email, 'booking@example.com');
    assert.equal(d.phone, '+972541234567');
  });

  test('throws a sanitized Shopify failure without logging contact details', async () => {
    const logged = [];
    console.error = (...args) => logged.push(args);
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          data: {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [{
                field: ['input', 'email'],
                message: 'Customer customer@example.com and +972541234567 are invalid',
              }],
            },
          },
        };
      },
    });

    await assert.rejects(
      createDraftOrder(SHOPIFY_ENV, baseOrder, 50),
      (error) => {
        assert.equal(error.code, 'shopify_draft_order_failed');
        assert.equal(error.details.kind, 'user_error');
        assert.deepEqual(error.details.errors, [{
          field: 'input.email',
          message: 'Customer [email] and [number] are invalid',
        }]);
        return true;
      },
    );
    const serialized = JSON.stringify(logged);
    assert.ok(serialized.includes('[email]'));
    assert.ok(serialized.includes('[number]'));
    assert.ok(!serialized.includes('customer@example.com'));
    assert.ok(!serialized.includes('+972541234567'));
  });

  test('coupon order: line item at subtotal, applied_discount for the difference', async () => {
    const captured = captureDraftFetch();
    const order = { ...baseOrder, price: 45, subtotal_price: 50, discount_code: 'SAVE10', discount_amount: 5, discount_title: 'Save 10' };
    const draft = await createDraftOrder(SHOPIFY_ENV, order, 45);
    assert.ok(draft);
    assert.ok(captured.url.endsWith('/graphql.json'));
    const d = captured.body.variables.input;
    assert.equal(d.lineItems[0].priceOverride.amount, '50.00');
    assert.equal(d.lineItems[0].variantId, 'gid://shopify/ProductVariant/52017093345597');
    assert.ok('appliedDiscount' in d);
    assert.equal(d.appliedDiscount.title, 'SAVE10');
    assert.equal(d.appliedDiscount.valueType, 'FIXED_AMOUNT');
    assert.equal(d.appliedDiscount.amountWithCurrency.amount, '5.00');
  });

  test('percentage coupon: line item at subtotal with applied_discount', async () => {
    const captured = captureDraftFetch();
    const order = { ...baseOrder, price: 76, subtotal_price: 85, discount_code: 'SAVE10', discount_amount: 9 };
    await createDraftOrder(SHOPIFY_ENV, order, 76);
    const d = captured.body.variables.input;
    assert.equal(d.lineItems[0].priceOverride.amount, '85.00');
    assert.equal(d.appliedDiscount.amountWithCurrency.amount, '9.00');
  });

  test('100% coupon: line item at subtotal, applied_discount covers the full amount', async () => {
    const captured = captureDraftFetch();
    const order = { ...baseOrder, price: 0, subtotal_price: 50, discount_code: 'FREE100', discount_amount: 50, discount_title: 'Free delivery' };
    await createDraftOrder(SHOPIFY_ENV, order, 0);
    const d = captured.body.variables.input;
    assert.equal(d.lineItems[0].priceOverride.amount, '50.00');
    assert.equal(d.appliedDiscount.amountWithCurrency.amount, '50.00');
  });

  test('non-coupon order: line item is the plain price, no applied_discount', async () => {
    const captured = captureDraftFetch();
    await createDraftOrder(SHOPIFY_ENV, { ...baseOrder, price: 50 }, 50);
    const d = captured.body.variables.input;
    assert.equal(d.lineItems[0].priceOverride.amount, '50.00');
    assert.ok(!('appliedDiscount' in d), 'no appliedDiscount for non-coupon orders');
    assert.equal(d.lineItems[0].variantId, 'gid://shopify/ProductVariant/52017093345597');
    assert.equal(d.lineItems[0].customAttributes.find(p => p.key === 'רמת שירות').value, 'רגיל (מסירה בתוך 4 שעות)');
    assert.ok(!/Standard|Eco|Flash/.test(JSON.stringify(d)), 'customer-facing Draft Order copy must be fully Hebrew');
  });

  test('maps every delivery service to its image-bearing Shopify variant', async () => {
    const variants = {
      eco: 'gid://shopify/ProductVariant/52017093312829',
      standard: 'gid://shopify/ProductVariant/52017093345597',
      flash: 'gid://shopify/ProductVariant/52017093378365',
    };
    for (const [service, variantId] of Object.entries(variants)) {
      const captured = captureDraftFetch();
      await createDraftOrder(SHOPIFY_ENV, { ...baseOrder, service }, 50);
      assert.equal(captured.body.variables.input.lineItems[0].variantId, variantId);
    }
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
    const session = await makeSession({ SESSION_SECRET: 'test-secret' });
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

describe('order lifecycle hardening', () => {
  test('delivered status is successful and idempotent', async () => {
    const orderRow = { id: 7, token: 'tok7', status: 'to_dropoff', price: 50, payment_mode: 'immediate', email: null };
    const db = apiDb({ orderRow });
    let res = await worker.fetch(await opsPost('/api/ops/orders/7/status', { status: 'delivered' }), envFor(db));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, settlement: { settled: true, noop: true } });
    assert.equal(orderRow.status, 'delivered');

    res = await worker.fetch(await opsPost('/api/ops/orders/7/status', { status: 'delivered' }), envFor(db));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, unchanged: true });
  });

  test('rejects unknown and backward status transitions', async () => {
    const orderRow = { id: 8, token: 'tok8', status: 'paid', price: 50 };
    const db = apiDb({ orderRow });
    for (const status of ['made_up', 'received']) {
      const res = await worker.fetch(await opsPost('/api/ops/orders/8/status', { status }), envFor(db));
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error, 'invalid transition');
    }
  });
});

describe('manual paid confirmation', () => {
  test('runs the full paid side effects once and is idempotent', async () => {
    const orderRow = {
      id: 12,
      token: 'manualpaidtoken123456',
      status: 'payment_sent',
      payment_status: 'link_sent',
      price: 50,
      currency: 'ILS',
      email: 'customer@example.com',
      name: 'Manual Customer',
      pickup: 'איסוף',
      dropoff: 'מסירה',
    };
    const db = apiDb({ orderRow });
    const sentEmails = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
      sentEmails.push(JSON.parse(init.body));
      return new Response(null, { status: 202 });
    };
    const env = {
      ...envFor(db),
      SENDGRID_API_KEY: 'sendgrid-test-key',
      OPS_EMAIL: 'ops@example.com',
      WHATSAPP_NUMBER: '972500000000',
    };

    let res = await worker.fetch(await opsPost('/api/ops/orders/12/status', { status: 'paid' }), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(orderRow.status, 'paid');
    assert.equal(orderRow.payment_status, 'paid');

    const payments = db.state.runs.filter(c => /INSERT INTO payments/.test(c.sql));
    assert.equal(payments.length, 1);
    assert.equal(payments[0].args[0], 12);
    assert.equal(payments[0].args[1], 5000);
    assert.match(payments[0].sql, /'paid'/);
    assert.equal(payments[0].args[2], null, 'manual payment must not invent a provider reference');

    const otpUpdate = db.state.runs.find(c => /UPDATE orders SET email = \?/.test(c.sql));
    assert.ok(otpUpdate, 'fresh OTP fields should be written');
    assert.equal(otpUpdate.args[0], 'customer@example.com');
    assert.equal(otpUpdate.args[3], 12);

    const attempts = db.state.runs.filter(c => /INSERT INTO notifications/.test(c.sql));
    assert.ok(attempts.some(c => c.args[1] === 'email' && c.args[2] === 'customer_payment_confirmation'));
    assert.ok(attempts.some(c => c.args[1] === 'email' && c.args[2] === 'ops_payment_received'));
    assert.ok(db.state.runs.some(c => (
      /INSERT OR IGNORE INTO delivery_notification_outbox/.test(c.sql)
      && c.args[2] === 'ops_payment_received'
    )));

    const customerEmail = sentEmails.find(message => message.subject === 'התשלום התקבל ✓ — קוד אימות וקישור למעקב');
    assert.ok(customerEmail, 'customer payment confirmation should be sent');
    const customerHtml = customerEmail.content[0].value;
    assert.match(customerHtml, /background:#ffffff/);
    assert.match(customerHtml, /color:#1f2937/);
    assert.match(customerHtml, /color-scheme:light/);
    assert.doesNotMatch(customerHtml, /#0b1326|#dae2fd|#dfb7ff/);

    const paymentCount = payments.length;
    const notificationCount = attempts.length;
    const outboxCount = db.state.outboxKeys.size;
    res = await worker.fetch(await opsPost('/api/ops/orders/12/status', { status: 'paid' }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, unchanged: true });
    assert.equal(
      db.state.runs.filter(c => /INSERT INTO payments/.test(c.sql)).length,
      paymentCount,
      'retry must not add a payment',
    );
    assert.equal(
      db.state.runs.filter(c => /INSERT INTO notifications/.test(c.sql)).length,
      notificationCount,
      'retry must not add notification attempts',
    );
    assert.equal(db.state.outboxKeys.size, outboxCount, 'retry must not duplicate the ops job');
  });

  test('fails the payment transition atomically when the ops outbox claim fails', async () => {
    const orderRow = {
      id: 13,
      token: 'atomicpaidtoken123456',
      status: 'payment_sent',
      payment_status: 'link_sent',
      price: 50,
      currency: 'ILS',
      email: null,
    };
    const db = apiDb({ orderRow });
    let batchCalls = 0;
    db.batch = async (statements) => {
      batchCalls += 1;
      assert.equal(statements.length, 4);
      assert.match(statements[0].sql || '', /delivery_notification_outbox/);
      throw new Error('simulated_atomic_write_failure');
    };

    await assert.rejects(
      worker.fetch(
        await opsPost('/api/ops/orders/13/status', { status: 'paid' }),
        envFor(db),
      ),
      /simulated_atomic_write_failure/,
    );
    assert.equal(batchCalls, 1);
    assert.equal(orderRow.status, 'payment_sent');
    assert.equal(orderRow.payment_status, 'link_sent');
    assert.equal(db.state.outboxKeys.size, 0);
    assert.equal(
      db.state.runs.filter(({ sql }) => /INSERT INTO payments/.test(sql)).length,
      0,
    );
  });
});

describe('OTP lockout and resend flow', () => {
  test('accepts the correct code, verifies the order, and resets prior failures', async () => {
    const token = 'otpsuccesstoken123456789';
    const env = { SESSION_SECRET: 'test-secret' };
    const orderRow = {
      id: 19, token, status: 'paid', payment_status: 'paid', email: 'customer@example.com',
      otp_hash: await hashOtp(env, '654321'), otp_expires: Date.now() + 10 * 60 * 1000,
    };
    const db = apiDb({ orderRow });
    db.state.rateLimits.set(`otpv:${token}`, {
      count: 2, window_start: Date.now(), last_at: Date.now(), locked_until: null,
    });

    const res = await worker.fetch(post(`/api/orders/${token}/verify-otp`, { code: '654321' }, nextIp()), { ...env, DB: db });
    assert.deepEqual(await res.json(), { verified: true });
    assert.ok(db.state.runs.some(c => /UPDATE orders SET email_verified = 1/.test(c.sql) && c.args[0] === 19));
    assert.ok(db.state.runs.some(c => /DELETE FROM rate_limits WHERE key = \?/.test(c.sql) && c.args[0] === `otpv:${token}`));
  });

  test('rejects an expired code without consuming a failed attempt', async () => {
    const token = 'otpexpiredtoken123456789';
    const env = { SESSION_SECRET: 'test-secret' };
    const orderRow = {
      id: 18, token, status: 'paid', payment_status: 'paid', email: 'customer@example.com',
      otp_hash: await hashOtp(env, '654321'), otp_expires: Date.now() - 1,
    };
    const db = apiDb({ orderRow });

    const res = await worker.fetch(post(`/api/orders/${token}/verify-otp`, { code: '000000' }, nextIp()), { ...env, DB: db });
    assert.deepEqual(await res.json(), { verified: false, error: 'expired' });
    assert.equal(db.state.rateLimits.has(`otpv:${token}`), false);
  });

  test('locks verification after five wrong codes and honors the active lock', async () => {
    const token = 'otpverifytoken1234567890';
    const env = { SESSION_SECRET: 'test-secret' };
    const orderRow = {
      id: 20, token, status: 'paid', payment_status: 'paid', email: 'customer@example.com',
      otp_hash: await hashOtp(env, '654321'), otp_expires: Date.now() + 10 * 60 * 1000,
    };
    const db = apiDb({ orderRow });
    const request = () => post(`/api/orders/${token}/verify-otp`, { code: '000000' }, nextIp());

    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await worker.fetch(request(), { ...env, DB: db });
      assert.deepEqual(await res.json(), { verified: false });
    }
    let res = await worker.fetch(request(), { ...env, DB: db });
    assert.deepEqual(await res.json(), { verified: false, error: 'locked' });
    const lock = db.state.rateLimits.get(`otpv:${token}`);
    assert.ok(lock.locked_until > Date.now());

    const runCount = db.state.runs.length;
    res = await worker.fetch(request(), { ...env, DB: db });
    assert.deepEqual(await res.json(), { verified: false, error: 'locked' });
    assert.equal(db.state.runs.length, runCount, 'an active lock must reject before another counter write');
  });

  test('resends once, writes a fresh OTP, then throttles an immediate retry', async () => {
    const token = 'otpresendtoken123456789';
    const orderRow = {
      id: 21, token, status: 'paid', payment_status: 'paid', email: 'customer@example.com',
    };
    const db = apiDb({ orderRow });
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
      return new Response(null, { status: 202 });
    };
    const env = { DB: db, SESSION_SECRET: 'test-secret', SENDGRID_API_KEY: 'sendgrid-test-key' };
    const request = () => post(`/api/orders/${token}/resend-otp`, {}, nextIp());

    let res = await worker.fetch(request(), env);
    assert.deepEqual(await res.json(), { ok: true });
    const otpWrites = () => db.state.runs.filter(c => /UPDATE orders SET email = \?/.test(c.sql));
    assert.equal(otpWrites().length, 1);
    assert.equal(otpWrites()[0].args[0], 'customer@example.com');
    assert.equal(otpWrites()[0].args[3], 21);
    assert.ok(db.state.runs.some(c => /INSERT INTO notifications/.test(c.sql) && c.args[2] === 'customer_otp'));

    res = await worker.fetch(request(), env);
    assert.deepEqual(await res.json(), { ok: false, error: 'throttled' });
    assert.equal(otpWrites().length, 1, 'throttled retries must not rotate the OTP');
  });

  test('does not reveal whether an unknown resend token exists', async () => {
    const db = apiDb();
    const res = await worker.fetch(post('/api/orders/unknown-token/resend-otp', {}, nextIp()), envFor(db));
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(!db.state.runs.some(c => /UPDATE orders SET email = \?/.test(c.sql)));
  });
});

describe('Shopify payment reconciliation', () => {
  const baseOrder = {
    id: 9, token: 'abcdef1234567890abcdef', status: 'payment_sent', payment_status: 'link_sent',
    price: 50, currency: 'ILS', shopify_draft_order_id: 123, shopify_order_id: 999, email: null,
  };
  const payload = {
    id: 999, draft_order_id: 123, financial_status: 'paid', total_price: '50.00', currency: 'ILS',
    line_items: [{ properties: [{ name: '_tracking_token', value: baseOrder.token }] }],
  };

  test('records the actual amount only when amount, currency, and draft match', async () => {
    const db = apiDb({ orderRow: { ...baseOrder } });
    let req = await shopifyWebhook(payload);
    let res = await worker.fetch(req, { DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).received, true);
    const payments = () => db.state.runs.filter(c => /INSERT INTO payments/.test(c.sql));
    assert.equal(payments().length, 1);
    assert.equal(payments()[0].args[1], 5000);

    req = await shopifyWebhook(payload);
    res = await worker.fetch(req, { DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret' });
    assert.deepEqual(await res.json(), { received: true });
    assert.equal(payments().length, 1, 'Shopify webhook retries must not duplicate payments');
  });

  test('uses the checkout email for the shared OTP confirmation flow', async () => {
    const db = apiDb({ orderRow: { ...baseOrder } });
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
      return new Response(null, { status: 202 });
    };
    const req = await shopifyWebhook({ ...payload, email: 'checkout@example.com' });
    const res = await worker.fetch(req, {
      DB: db,
      SESSION_SECRET: 'test-secret',
      SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
      SENDGRID_API_KEY: 'sendgrid-test-key',
    });
    assert.equal(res.status, 200);
    const otpUpdate = db.state.runs.find(c => /UPDATE orders SET email = \?/.test(c.sql));
    assert.ok(otpUpdate);
    assert.equal(otpUpdate.args[0], 'checkout@example.com');
    assert.ok(db.state.runs.some(c => /INSERT INTO notifications/.test(c.sql) && c.args[2] === 'customer_payment_confirmation'));
  });

  test('quarantines a paid webhook whose amount does not match', async () => {
    const db = apiDb({ orderRow: { ...baseOrder } });
    const req = await shopifyWebhook({ ...payload, total_price: '1.00' });
    const res = await worker.fetch(req, { DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, reconciled: false });
    const mismatch = db.state.runs.find(c => /payment_status=\?/.test(c.sql) && c.args[0] === 'mismatch');
    assert.ok(mismatch);
    assert.equal(mismatch.args[2], 'payment_mismatch');
    assert.ok(!db.state.runs.some(c => /INSERT INTO payments/.test(c.sql)));
  });

  test('marks a newly created refund pending without treating it as complete', async () => {
    const orderRow = { ...baseOrder, status: 'paid', payment_status: 'paid' };
    const db = apiDb({ orderRow });
    const refund = {
      id: 7001,
      order_id: 999,
      transactions: [{ id: 8001, kind: 'refund', status: 'pending', amount: '50.00', currency: 'ILS' }],
    };

    let res = await worker.fetch(await shopifyWebhook(refund, 'webhook-secret', 'refunds/create'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: true });
    assert.equal(orderRow.status, 'refund_pending');
    assert.equal(orderRow.payment_status, 'refund_pending');
    assert.equal(orderRow.review_flag, 1);

    const runCount = db.state.runs.length;
    res = await worker.fetch(await shopifyWebhook(refund, 'webhook-secret', 'refunds/create'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: true });
    assert.equal(db.state.runs.length, runCount, 'refund webhook retries must be idempotent');
  });

  test('finalizes a successful full refund as cancelled and refunded', async () => {
    const orderRow = { ...baseOrder, status: 'paid', payment_status: 'paid' };
    const db = apiDb({ orderRow });
    const refund = {
      id: 7002,
      order_id: 999,
      transactions: [{ id: 8002, kind: 'refund', status: 'success', amount: '50.00', currency: 'ILS' }],
    };
    const res = await worker.fetch(await shopifyWebhook(refund, 'webhook-secret', 'refunds/create'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: true });
    assert.equal(orderRow.status, 'cancelled');
    assert.equal(orderRow.payment_status, 'refunded');
    assert.equal(orderRow.review_flag, 0);
  });

  test('uses orders/updated to finalize a pending refund without a tracking property', async () => {
    const orderRow = { ...baseOrder, status: 'refund_pending', payment_status: 'refund_pending' };
    const db = apiDb({ orderRow });
    const update = { id: 999, financial_status: 'refunded', total_price: '50.00', currency: 'ILS', line_items: [] };
    const res = await worker.fetch(await shopifyWebhook(update, 'webhook-secret', 'orders/updated'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: true });
    assert.equal(orderRow.status, 'cancelled');
    assert.equal(orderRow.payment_status, 'refunded');
  });

  test('keeps partial, failed, and currency-mismatched refunds under review', async () => {
    const cases = [
      [{ transactions: [{ kind: 'refund', status: 'success', amount: '10.00', currency: 'ILS' }] }, 'partially_refunded', 'partial_refund'],
      [{ transactions: [{ kind: 'refund', status: 'failure', amount: '50.00', currency: 'ILS' }] }, 'refund_failed', 'refund_failed'],
      [{ transactions: [{ kind: 'refund', status: 'success', amount: '50.00', currency: 'USD' }] }, 'refund_mismatch', 'refund_currency_mismatch'],
    ];
    for (const [extra, expectedPayment, expectedReason] of cases) {
      const orderRow = { ...baseOrder, status: 'paid', payment_status: 'paid' };
      const db = apiDb({ orderRow });
      const refund = { id: 7100, order_id: 999, ...extra };
      const res = await worker.fetch(await shopifyWebhook(refund, 'webhook-secret', 'refunds/create'), {
        DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
      });
      assert.equal(res.status, 200);
      assert.equal(orderRow.status, 'refund_pending');
      assert.equal(orderRow.payment_status, expectedPayment);
      assert.equal(orderRow.review_reason, expectedReason);
      assert.equal(orderRow.review_flag, 1);
    }
  });

  test('does not let a late paid event regress an order being refunded', async () => {
    const orderRow = { ...baseOrder, status: 'refund_pending', payment_status: 'refund_pending' };
    const db = apiDb({ orderRow });
    const res = await worker.fetch(await shopifyWebhook(payload), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true });
    assert.equal(orderRow.status, 'refund_pending');
    assert.equal(orderRow.payment_status, 'refund_pending');
    assert.ok(!db.state.runs.some(c => /INSERT INTO payments/.test(c.sql)));
  });

  test('does not let an out-of-order pending refund reopen a completed refund', async () => {
    const orderRow = { ...baseOrder, status: 'cancelled', payment_status: 'refunded' };
    const db = apiDb({ orderRow });
    const refund = {
      id: 7004,
      order_id: 999,
      transactions: [{ kind: 'refund', status: 'pending', amount: '50.00', currency: 'ILS' }],
    };
    const res = await worker.fetch(await shopifyWebhook(refund, 'webhook-secret', 'refunds/create'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: true });
    assert.equal(orderRow.status, 'cancelled');
    assert.equal(orderRow.payment_status, 'refunded');
    assert.equal(db.state.runs.length, 0);
  });

  test('acknowledges unsupported signed Shopify topics without changing an order', async () => {
    const orderRow = { ...baseOrder };
    const db = apiDb({ orderRow });
    const res = await worker.fetch(await shopifyWebhook(payload, 'webhook-secret', 'orders/create'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: false });
    assert.equal(db.state.runs.length, 0);
    assert.equal(orderRow.payment_status, 'link_sent');
  });

  test('acknowledges a refund for an unknown Shopify order without writes', async () => {
    const db = apiDb();
    const refund = { id: 7003, order_id: 404, transactions: [] };
    const res = await worker.fetch(await shopifyWebhook(refund, 'webhook-secret', 'refunds/create'), {
      DB: db, SHOPIFY_WEBHOOK_SECRET: 'webhook-secret',
    });
    assert.deepEqual(await res.json(), { received: true, reconciled: false });
    assert.equal(db.state.runs.length, 0);
  });
});
