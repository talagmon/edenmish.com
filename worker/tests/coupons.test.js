// Unit tests for worker/src/coupons.js + fetchShopifyDiscountByCode.
// Run with: npm test (node --test). No real D1/Shopify — both are mocked.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, computeDiscount, validateCoupon, recordRedemption } from '../src/coupons.js';
import { fetchShopifyDiscountByCode } from '../src/integrations.js';

// ---- mocks ----

// Minimal D1 stub: routes prepare(sql).bind(...).first()/run() by SQL shape.
function mockDb({ coupon = null, redemptionsTotal = 0, redemptionsByCustomer = 0 } = {}) {
  const calls = { selects: [], runs: [] };
  return {
    calls,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM coupons/.test(sql)) {
            calls.selects.push({ sql, args: this.args });
            return coupon;
          }
          if (/FROM coupon_redemptions/.test(sql)) {
            return { n: /customer_key/.test(sql) ? redemptionsByCustomer : redemptionsTotal };
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() { calls.runs.push({ sql, args: this.args }); return {}; },
      };
    },
  };
}

// A fresh (non-stale) cached coupon row so validateCoupon never calls Shopify.
function freshCoupon(overrides = {}) {
  return {
    code: 'SAVE10',
    shopify_discount_id: 'gid://shopify/DiscountCodeNode/1',
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

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockShopifyFetch(codeDiscountNodeByCode) {
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { data: { codeDiscountNodeByCode } }; },
  });
}

const SHOPIFY_ENV = { SHOPIFY_SHOP: 'test.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_test' };
const NO_ENV = {}; // no Shopify creds → lookup throws → stale-while-error path

// ---- normalizeCode ----

describe('normalizeCode', () => {
  test('trims and uppercases', () => {
    assert.equal(normalizeCode('  summer10 '), 'SUMMER10');
    assert.equal(normalizeCode('Save-5'), 'SAVE-5');
  });
  test('handles null/undefined', () => {
    assert.equal(normalizeCode(null), '');
    assert.equal(normalizeCode(undefined), '');
  });
});

// ---- computeDiscount ----

describe('computeDiscount', () => {
  test('percentage math (rounds to integer shekels)', () => {
    assert.equal(computeDiscount({ value_type: 'percentage', value: 15 }, 100), 15);
    assert.equal(computeDiscount({ value_type: 'percentage', value: 10 }, 85), 9); // 8.5 → 9
    assert.equal(computeDiscount({ value_type: 'percentage', value: 100 }, 50), 50);
  });
  test('fixed amount', () => {
    assert.equal(computeDiscount({ value_type: 'fixed_amount', value: 20 }, 85), 20);
  });
  test('fixed amount larger than subtotal clamps to subtotal (free order)', () => {
    assert.equal(computeDiscount({ value_type: 'fixed_amount', value: 100 }, 50), 50);
  });
  test('never negative', () => {
    assert.equal(computeDiscount({ value_type: 'fixed_amount', value: -5 }, 50), 0);
    assert.equal(computeDiscount({ value_type: 'percentage', value: 10 }, 0), 0);
  });
});

// ---- validateCoupon (fresh cached rows — no Shopify call) ----

describe('validateCoupon', () => {
  test('valid percentage coupon', async () => {
    const db = mockDb({ coupon: freshCoupon() });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85, 'a@b.com');
    assert.deepEqual(r, {
      valid: true, code: 'SAVE10', title: 'Save 10', valueType: 'percentage',
      value: 10, subtotal: 85, discountAmount: 9, price: 76,
      usageLimit: null, appliesOncePerCustomer: false,
    });
  });

  test('case-insensitive: lowercase input is normalized before lookup', async () => {
    const db = mockDb({ coupon: freshCoupon() });
    const r = await validateCoupon(db, NO_ENV, '  save10 ', 100);
    assert.equal(r.valid, true);
    assert.equal(r.code, 'SAVE10');
    assert.equal(db.calls.selects[0].args[0], 'SAVE10'); // D1 queried with normalized code
  });

  test('fixed discount bigger than price → free order, price 0 (never negative)', async () => {
    const db = mockDb({ coupon: freshCoupon({ value_type: 'fixed_amount', value: 100 }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 50);
    assert.equal(r.valid, true);
    assert.equal(r.discountAmount, 50);
    assert.equal(r.price, 0);
  });

  test('expired coupon (ends_at in the past)', async () => {
    const db = mockDb({ coupon: freshCoupon({ ends_at: Date.now() - 1000 }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'expired' });
  });

  test('not-yet-started coupon (starts_at in the future)', async () => {
    const db = mockDb({ coupon: freshCoupon({ starts_at: Date.now() + 60_000 }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'not_started' });
  });

  test('inactive status', async () => {
    const db = mockDb({ coupon: freshCoupon({ status: 'disabled' }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'inactive' });
  });

  test('usage limit reached', async () => {
    const db = mockDb({ coupon: freshCoupon({ usage_limit: 3 }), redemptionsTotal: 3 });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'usage_limit_reached' });
  });

  test('usage limit not yet reached → valid', async () => {
    const db = mockDb({ coupon: freshCoupon({ usage_limit: 3 }), redemptionsTotal: 2 });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.equal(r.valid, true);
  });

  test('once-per-customer already used', async () => {
    const db = mockDb({
      coupon: freshCoupon({ applies_once_per_customer: 1 }),
      redemptionsByCustomer: 1,
    });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85, 'a@b.com');
    assert.deepEqual(r, { valid: false, reason: 'already_used' });
  });

  test('once-per-customer without customerKey does not block', async () => {
    const db = mockDb({
      coupon: freshCoupon({ applies_once_per_customer: 1 }),
      redemptionsByCustomer: 1,
    });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.equal(r.valid, true);
  });

  test('unknown value_type in cache → unsupported', async () => {
    const db = mockDb({ coupon: freshCoupon({ value_type: 'bogus' }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'unsupported' });
  });

  test('no cache + Shopify unreachable → not_found', async () => {
    const db = mockDb({ coupon: null });
    const r = await validateCoupon(db, NO_ENV, 'NOPE', 85);
    assert.deepEqual(r, { valid: false, reason: 'not_found' });
  });

  test('stale cache + Shopify unreachable → falls back to cached row (stale-while-error)', async () => {
    // 15 min old: past the 10-min sync TTL but within the 2×TTL fallback window.
    const db = mockDb({ coupon: freshCoupon({ synced_at: Date.now() - 15 * 60 * 1000 }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 100);
    assert.equal(r.valid, true);
    assert.equal(r.discountAmount, 10);
  });

  test('cache older than 2× the sync TTL + Shopify unreachable → rejected (not_found)', async () => {
    const db = mockDb({ coupon: freshCoupon({ synced_at: Date.now() - 21 * 60 * 1000 }) });
    const r = await validateCoupon(db, NO_ENV, 'SAVE10', 100);
    assert.deepEqual(r, { valid: false, reason: 'not_found' });
  });

  test('stale cache + Shopify lookup → upserts fresh definition into D1', async () => {
    mockShopifyFetch({
      id: 'gid://shopify/DiscountCodeNode/2',
      codeDiscount: {
        __typename: 'DiscountCodeBasic',
        title: 'Half off',
        status: 'ACTIVE',
        startsAt: null, endsAt: null,
        usageLimit: null, appliesOncePerCustomer: false,
        customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.5 } },
      },
    });
    const db = mockDb({ coupon: null });
    const r = await validateCoupon(db, SHOPIFY_ENV, 'half', 80);
    assert.equal(r.valid, true);
    assert.equal(r.value, 50);
    assert.equal(r.discountAmount, 40);
    assert.equal(r.price, 40);
    const upsert = db.calls.runs.find(c => /INSERT INTO coupons/.test(c.sql));
    assert.ok(upsert, 'expected an upsert into coupons');
    assert.equal(upsert.args[0], 'HALF'); // stored normalized uppercase
  });

  test('Shopify says code does not exist → not_found', async () => {
    mockShopifyFetch(null);
    const db = mockDb({ coupon: null });
    const r = await validateCoupon(db, SHOPIFY_ENV, 'GHOST', 85);
    assert.deepEqual(r, { valid: false, reason: 'not_found' });
  });

  test('unsupported Shopify discount type (BxGy) → unsupported', async () => {
    mockShopifyFetch({
      id: 'gid://shopify/DiscountCodeNode/3',
      codeDiscount: { __typename: 'DiscountCodeBxgy', title: 'Buy X get Y' },
    });
    const db = mockDb({ coupon: null });
    const r = await validateCoupon(db, SHOPIFY_ENV, 'BXGY', 85);
    assert.deepEqual(r, { valid: false, reason: 'unsupported' });
  });
});

// ---- fetchShopifyDiscountByCode ----

describe('fetchShopifyDiscountByCode', () => {
  test('converts Shopify 0..1 fraction to 0-100 percent (no float dust)', async () => {
    mockShopifyFetch({
      id: 'gid://shopify/DiscountCodeNode/4',
      codeDiscount: {
        __typename: 'DiscountCodeBasic',
        title: '15% off', status: 'ACTIVE',
        startsAt: '2026-01-01T00:00:00Z', endsAt: null,
        usageLimit: 100, appliesOncePerCustomer: true,
        customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.15 } },
      },
    });
    const row = await fetchShopifyDiscountByCode(SHOPIFY_ENV, 'save15');
    assert.equal(row.value_type, 'percentage');
    assert.equal(row.value, 15); // 0.15 * 100 → exactly 15, not 15.000000000000002
    assert.equal(row.code, 'SAVE15');
    assert.equal(row.status, 'active');
    assert.equal(row.starts_at, Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(row.ends_at, null);
    assert.equal(row.usage_limit, 100);
    assert.equal(row.applies_once_per_customer, 1);
  });

  test('fixed amount in ILS', async () => {
    mockShopifyFetch({
      id: 'gid://shopify/DiscountCodeNode/5',
      codeDiscount: {
        __typename: 'DiscountCodeBasic',
        title: '20 NIS off', status: 'ACTIVE',
        startsAt: null, endsAt: null, usageLimit: null, appliesOncePerCustomer: false,
        customerGets: { value: { __typename: 'DiscountAmount', amount: { amount: '20.0', currencyCode: 'ILS' } } },
      },
    });
    const row = await fetchShopifyDiscountByCode(SHOPIFY_ENV, 'NIS20');
    assert.equal(row.value_type, 'fixed_amount');
    assert.equal(row.value, 20);
  });

  test('non-Basic discount type → { unsupported: true }', async () => {
    mockShopifyFetch({
      id: 'gid://shopify/DiscountCodeNode/6',
      codeDiscount: { __typename: 'DiscountCodeFreeShipping', title: 'Free shipping' },
    });
    const row = await fetchShopifyDiscountByCode(SHOPIFY_ENV, 'FREESHIP');
    assert.deepEqual(row, { unsupported: true });
  });

  test('no such code → null', async () => {
    mockShopifyFetch(null);
    assert.equal(await fetchShopifyDiscountByCode(SHOPIFY_ENV, 'GHOST'), null);
  });

  test('missing credentials → throws (caller falls back to cache)', async () => {
    await assert.rejects(() => fetchShopifyDiscountByCode(NO_ENV, 'X'), /shopify_not_configured/);
  });

  test('HTTP error → throws', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
    await assert.rejects(() => fetchShopifyDiscountByCode(SHOPIFY_ENV, 'X'), /shopify_http_500/);
  });
});

// ---- recordRedemption ----

// D1 stub that EVALUATES the conditional-insert guard the way SQLite would:
// counts its in-memory redemptions per guard subquery and only "inserts" (and
// returns meta.changes = 1) when every guard holds. Lets us test the atomic
// usage-limit guard without a real D1.
function guardDb(existing = []) {
  const redemptions = existing.map(r => ({ ...r }));
  return {
    redemptions,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (!/INSERT INTO coupon_redemptions/.test(sql)) return { meta: { changes: 1 } };
          const [order_id, code, customer_key] = this.args;
          let i = 7; // guard binds start after the 7 VALUES/SELECT binds
          let ok = true;
          if (/WHERE code = \?\) < \?/.test(sql)) {
            const [guardCode, limit] = [this.args[i], this.args[i + 1]]; i += 2;
            if (redemptions.filter(r => r.code === guardCode).length >= limit) ok = false;
          }
          if (/customer_key = \?\) = 0/.test(sql)) {
            const [guardCode, guardKey] = [this.args[i], this.args[i + 1]]; i += 2;
            if (redemptions.some(r => r.code === guardCode && r.customer_key === guardKey)) ok = false;
          }
          if (ok) redemptions.push({ order_id, code, customer_key });
          return { meta: { changes: ok ? 1 : 0 } };
        },
      };
    },
  };
}

describe('recordRedemption', () => {
  test('no limits → unconditional insert of a normalized row with created_at', async () => {
    const db = mockDb();
    const before = Date.now();
    const r = await recordRedemption(db, {
      orderId: 7, code: ' save10 ', customerKey: 'a@b.com',
      priceBefore: 85, discountAmount: 9, priceAfter: 76,
    });
    assert.deepEqual(r, { recorded: true });
    const ins = db.calls.runs.find(c => /INSERT INTO coupon_redemptions/.test(c.sql));
    assert.ok(ins, 'expected an insert into coupon_redemptions');
    assert.ok(!/WHERE/.test(ins.sql), 'no-limit coupons skip the conditional guard');
    const [orderId, code, customerKey, priceBefore, discountAmount, priceAfter, createdAt] = ins.args;
    assert.equal(orderId, 7);
    assert.equal(code, 'SAVE10');
    assert.equal(customerKey, 'a@b.com');
    assert.equal(priceBefore, 85);
    assert.equal(discountAmount, 9);
    assert.equal(priceAfter, 76);
    assert.ok(createdAt >= before && createdAt <= Date.now());
  });

  test('atomic guard: concurrency-shaped — two racers past validation, only one records (limit 1)', async () => {
    // Both requests validated while the count was 0; the guard serializes them.
    const db = guardDb();
    const first = await recordRedemption(db, { orderId: 1, code: 'SAVE10', usageLimit: 1 });
    const second = await recordRedemption(db, { orderId: 2, code: 'SAVE10', usageLimit: 1 });
    assert.deepEqual(first, { recorded: true });
    assert.deepEqual(second, { recorded: false }); // guard insert → changes = 0 at limit
    assert.equal(db.redemptions.length, 1);
    assert.equal(db.redemptions[0].order_id, 1);
  });

  test('atomic guard: insert rejected when count already at usage_limit', async () => {
    const db = guardDb([{ order_id: 1, code: 'SAVE10', customer_key: 'x' }, { order_id: 2, code: 'SAVE10', customer_key: 'y' }]);
    const r = await recordRedemption(db, { orderId: 3, code: 'SAVE10', usageLimit: 2 });
    assert.deepEqual(r, { recorded: false });
    assert.equal(db.redemptions.length, 2, 'no row inserted past the limit');
  });

  test('atomic guard: once-per-customer rejects a second redemption for the same key only', async () => {
    const db = guardDb([{ order_id: 1, code: 'SAVE10', customer_key: 'a@b.com' }]);
    const dup = await recordRedemption(db, { orderId: 2, code: 'SAVE10', customerKey: 'a@b.com', oncePerCustomer: true });
    assert.deepEqual(dup, { recorded: false });
    const other = await recordRedemption(db, { orderId: 3, code: 'SAVE10', customerKey: 'c@d.com', oncePerCustomer: true });
    assert.deepEqual(other, { recorded: true });
  });

  test('once-per-customer without a customerKey skips the guard (matches validateCoupon)', async () => {
    const db = guardDb([{ order_id: 1, code: 'SAVE10', customer_key: 'a@b.com' }]);
    const r = await recordRedemption(db, { orderId: 2, code: 'SAVE10', customerKey: null, oncePerCustomer: true });
    assert.deepEqual(r, { recorded: true });
  });
});
