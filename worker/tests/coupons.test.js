// Unit tests for worker/src/coupons.js — D1-only coupons (no Shopify).
// Run with: npm test (node --test). D1 is mocked.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode, normalizeBusinessPlanIds, computeDiscount, validateCoupon, recordRedemption, recordBusinessRedemption, releaseBusinessRedemption,
  listCoupons, createCoupon, updateCoupon, deleteCoupon,
} from '../src/coupons.js';

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

// A D1 coupon row as the ops dashboard would have created it.
function d1Coupon(overrides = {}) {
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
    scope: 'delivery',
    business_plan_ids: null,
    auto_apply: 0,
    eligibility_rule: null,
    synced_at: Date.now(),
    ...overrides,
  };
}

// validateCoupon still takes an env arg (unused for lookups) — nothing here
// touches the network.
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

describe('normalizeBusinessPlanIds', () => {
  test('accepts arrays or stored JSON and removes invalid plans', () => {
    assert.deepEqual(normalizeBusinessPlanIds(['gold', 'trial', 'gold', 'unknown']), ['gold', 'trial']);
    assert.deepEqual(normalizeBusinessPlanIds('["silver","platinum"]'), ['silver', 'platinum']);
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

// ---- validateCoupon (reads the D1 row directly) ----

describe('validateCoupon', () => {
  test('valid percentage coupon', async () => {
    const db = mockDb({ coupon: d1Coupon() });
    const r = await validateCoupon(db, 'SAVE10', 85, 'a@b.com');
    assert.deepEqual(r, {
      valid: true, code: 'SAVE10', title: 'Save 10', valueType: 'percentage',
      value: 10, subtotal: 85, discountAmount: 9, price: 76,
      usageLimit: null, appliesOncePerCustomer: false,
      autoApply: false, eligibilityRule: null,
    });
  });

  test('case-insensitive: lowercase input is normalized before lookup', async () => {
    const db = mockDb({ coupon: d1Coupon() });
    const r = await validateCoupon(db, '  save10 ', 100);
    assert.equal(r.valid, true);
    assert.equal(r.code, 'SAVE10');
    assert.equal(db.calls.selects[0].args[0], 'SAVE10'); // D1 queried with normalized code
  });

  test('fixed discount bigger than price → free order, price 0 (never negative)', async () => {
    const db = mockDb({ coupon: d1Coupon({ value_type: 'fixed_amount', value: 100 }) });
    const r = await validateCoupon(db, 'SAVE10', 50);
    assert.equal(r.valid, true);
    assert.equal(r.discountAmount, 50);
    assert.equal(r.price, 0);
  });

  test('expired coupon (ends_at in the past)', async () => {
    const db = mockDb({ coupon: d1Coupon({ ends_at: Date.now() - 1000 }) });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'expired' });
  });

  test('not-yet-started coupon (starts_at in the future)', async () => {
    const db = mockDb({ coupon: d1Coupon({ starts_at: Date.now() + 60_000 }) });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'not_started' });
  });

  test('inactive status', async () => {
    const db = mockDb({ coupon: d1Coupon({ status: 'disabled' }) });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'inactive' });
  });

  test('usage limit reached', async () => {
    const db = mockDb({ coupon: d1Coupon({ usage_limit: 3 }), redemptionsTotal: 3 });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'usage_limit_reached' });
  });

  test('usage limit not yet reached → valid', async () => {
    const db = mockDb({ coupon: d1Coupon({ usage_limit: 3 }), redemptionsTotal: 2 });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.equal(r.valid, true);
  });

  test('once-per-customer already used', async () => {
    const db = mockDb({
      coupon: d1Coupon({ applies_once_per_customer: 1 }),
      redemptionsByCustomer: 1,
    });
    const r = await validateCoupon(db, 'SAVE10', 85, 'a@b.com');
    assert.deepEqual(r, { valid: false, reason: 'already_used' });
  });

  test('once-per-customer without customerKey does not block', async () => {
    const db = mockDb({
      coupon: d1Coupon({ applies_once_per_customer: 1 }),
      redemptionsByCustomer: 1,
    });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.equal(r.valid, true);
  });

  test('unknown value_type → unsupported', async () => {
    const db = mockDb({ coupon: d1Coupon({ value_type: 'bogus' }) });
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'unsupported' });
  });

  test('no such code in D1 → not_found', async () => {
    const db = mockDb({ coupon: null });
    const r = await validateCoupon(db, 'NOPE', 85);
    assert.deepEqual(r, { valid: false, reason: 'not_found' });
  });

  test('empty/blank code → not_found without a D1 lookup', async () => {
    const db = mockDb({ coupon: d1Coupon() });
    const r = await validateCoupon(db, '   ', 85);
    assert.deepEqual(r, { valid: false, reason: 'not_found' });
    assert.equal(db.calls.selects.length, 0);
  });

  test('business-plan coupons are scoped and can target selected plans', async () => {
    const coupon = d1Coupon({ scope: 'business_plan', business_plan_ids: '["gold","platinum"]' });
    assert.equal((await validateCoupon(mockDb({ coupon }), 'SAVE10', 1500, 'owner@example.com')).reason, 'not_applicable');
    assert.equal((await validateCoupon(mockDb({ coupon }), 'SAVE10', 1500, 'owner@example.com', { scope: 'business_plan', planId: 'silver' })).reason, 'not_applicable');
    const valid = await validateCoupon(mockDb({ coupon }), 'SAVE10', 1500, 'owner@example.com', { scope: 'business_plan', planId: 'gold' });
    assert.equal(valid.valid, true);
    assert.equal(valid.price, 1350);
  });
});

// ---- CRUD (ops dashboard) ----

// In-memory D1 stub that actually stores coupon rows so create → read → update
// → soft-delete round-trips work. UPDATEs are applied by parsing the `col = ?`
// pairs in the SET clause (the last bind is always the code).
function crudDb({ coupons = [], redemptions = [] } = {}) {
  const store = new Map(coupons.map(c => [c.code, { ...c }]));
  return {
    store, redemptions,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/SELECT \* FROM coupons WHERE code/.test(sql)) return store.get(this.args[0]) || null;
          if (/FROM coupon_redemptions/.test(sql)) {
            const code = this.args[0];
            const byCustomer = /customer_key/.test(sql);
            const n = redemptions.filter(r => r.code === code && (!byCustomer || r.customer_key === this.args[1])).length;
            return { n };
          }
          return null;
        },
        async all() {
          if (/FROM coupons c/.test(sql)) {
            const rows = [...store.values()].map(c => ({
              ...c,
              redemption_count: redemptions.filter(r => r.code === c.code).length,
            }));
            rows.sort((a, b) => (b.synced_at || 0) - (a.synced_at || 0));
            return { results: rows };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO coupons/.test(sql)) {
            const [code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, scope, business_plan_ids, auto_apply, eligibility_rule, synced_at] = this.args;
            store.set(code, { code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, scope, business_plan_ids, auto_apply, eligibility_rule, synced_at });
          } else if (/UPDATE coupons SET/.test(sql)) {
            const cols = [...sql.split(' WHERE ')[0].matchAll(/(\w+) = \?/g)].map(m => m[1]);
            const row = store.get(this.args[this.args.length - 1]);
            cols.forEach((col, i) => { row[col] = this.args[i]; });
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

describe('createCoupon', () => {
  test('creates a normalized row and returns it (defaults: active, no limits)', async () => {
    const db = crudDb();
    const before = Date.now();
    const c = await createCoupon(db, { code: ' save10 ', title: ' Save 10 ', value_type: 'percentage', value: 10 });
    assert.equal(c.code, 'SAVE10'); // stored normalized uppercase
    assert.equal(c.title, 'Save 10');
    assert.equal(c.value_type, 'percentage');
    assert.equal(c.value, 10);
    assert.equal(c.status, 'active');
    assert.equal(c.starts_at, null);
    assert.equal(c.ends_at, null);
    assert.equal(c.usage_limit, null);
    assert.equal(c.applies_once_per_customer, 0);
    assert.equal(c.auto_apply, 0);
    assert.equal(c.eligibility_rule, null);
    assert.ok(c.synced_at >= before && c.synced_at <= Date.now());
    assert.ok(db.store.has('SAVE10'));
  });

  test('honors optional fields (dates, limit, once-per-customer, status)', async () => {
    const db = crudDb();
    const starts = Date.now() + 60_000, ends = Date.now() + 120_000;
    const c = await createCoupon(db, {
      code: 'VIP', value_type: 'fixed_amount', value: 20, status: 'scheduled',
      starts_at: starts, ends_at: ends, usage_limit: 5, applies_once_per_customer: true,
    });
    assert.equal(c.status, 'scheduled');
    assert.equal(c.starts_at, starts);
    assert.equal(c.ends_at, ends);
    assert.equal(c.usage_limit, 5);
    assert.equal(c.applies_once_per_customer, 1);
  });

  test('stores business-plan scope and selected plan IDs', async () => {
    const db = crudDb();
    const c = await createCoupon(db, {
      code: 'BIZ20', title: 'Business 20', value_type: 'fixed_amount', value: 20,
      scope: 'business_plan', business_plan_ids: ['trial', 'gold', 'unknown'],
    });
    assert.equal(c.scope, 'business_plan');
    assert.equal(c.business_plan_ids, '["trial","gold"]');
  });

  test('duplicate code → throws coupon_exists', async () => {
    const db = crudDb({ coupons: [d1Coupon()] });
    await assert.rejects(
      () => createCoupon(db, { code: 'save10', value_type: 'percentage', value: 5 }),
      /coupon_exists/
    );
  });

  test('rejects missing code, bad value_type, and non-positive value', async () => {
    const db = crudDb();
    await assert.rejects(() => createCoupon(db, { code: '  ', value_type: 'percentage', value: 10 }), /missing code/);
    await assert.rejects(() => createCoupon(db, { code: 'X', value_type: 'bxgy', value: 10 }), /invalid value_type/);
    await assert.rejects(() => createCoupon(db, { code: 'X', value_type: 'percentage', value: 0 }), /invalid value/);
    await assert.rejects(() => createCoupon(db, { code: 'X', value_type: 'fixed_amount', value: -5 }), /invalid value/);
    assert.equal(db.store.size, 0, 'nothing inserted');
  });

  test('a created coupon validates immediately (no sync step)', async () => {
    const db = crudDb();
    await createCoupon(db, { code: 'FRESH', title: 'Fresh', value_type: 'fixed_amount', value: 15 });
    const r = await validateCoupon(db, 'fresh', 50);
    assert.equal(r.valid, true);
    assert.equal(r.discountAmount, 15);
    assert.equal(r.price, 35);
  });

  test('enforces safe automatic first-delivery field combinations', async () => {
    const db = crudDb();
    await assert.rejects(
      () => createCoupon(db, {
        code: 'AUTO',
        value_type: 'percentage',
        value: 10,
        auto_apply: true,
      }),
      /automatic coupons require first_delivery/,
    );
    await assert.rejects(
      () => createCoupon(db, {
        code: 'FIRST',
        value_type: 'percentage',
        value: 10,
        eligibility_rule: 'first_delivery',
        applies_once_per_customer: true,
        scope: 'business_plan',
        ends_at: 1788209999999,
      }),
      /requires delivery scope/,
    );
    const created = await createCoupon(db, {
      code: 'FIRST10',
      value_type: 'percentage',
      value: 10,
      auto_apply: true,
      eligibility_rule: 'first_delivery',
      applies_once_per_customer: true,
      scope: 'delivery',
      ends_at: 1788209999999,
    });
    assert.equal(created.auto_apply, 1);
    assert.equal(created.eligibility_rule, 'first_delivery');
  });
});

describe('updateCoupon', () => {
  test('updates only the given fields and bumps synced_at', async () => {
    const db = crudDb({ coupons: [d1Coupon({ synced_at: 1000 })] });
    const c = await updateCoupon(db, 'save10', { value: 25, usage_limit: 3 });
    assert.equal(c.value, 25);
    assert.equal(c.usage_limit, 3);
    assert.equal(c.title, 'Save 10', 'untouched field preserved');
    assert.equal(c.status, 'active', 'untouched field preserved');
    assert.ok(c.synced_at > 1000, 'synced_at bumped');
  });

  test('normalizes booleans and nullable numbers', async () => {
    const db = crudDb({ coupons: [d1Coupon({ usage_limit: 5, applies_once_per_customer: 1 })] });
    const c = await updateCoupon(db, 'SAVE10', { applies_once_per_customer: false, usage_limit: null, ends_at: 123456 });
    assert.equal(c.applies_once_per_customer, 0);
    assert.equal(c.usage_limit, null);
    assert.equal(c.ends_at, 123456);
  });

  test('unknown code → null', async () => {
    const db = crudDb();
    assert.equal(await updateCoupon(db, 'GHOST', { value: 10 }), null);
  });

  test('no recognized fields → returns the row unchanged (no UPDATE)', async () => {
    const db = crudDb({ coupons: [d1Coupon({ synced_at: 1000 })] });
    const c = await updateCoupon(db, 'SAVE10', { bogus: 'x' });
    assert.equal(c.synced_at, 1000, 'synced_at untouched');
  });
});

describe('deleteCoupon', () => {
  test('soft-delete: row stays, status becomes inactive, code stops validating', async () => {
    const db = crudDb({ coupons: [d1Coupon()] });
    const c = await deleteCoupon(db, ' save10 ');
    assert.equal(c.status, 'inactive');
    assert.ok(db.store.has('SAVE10'), 'row not removed from D1');
    const r = await validateCoupon(db, 'SAVE10', 85);
    assert.deepEqual(r, { valid: false, reason: 'inactive' });
  });

  test('unknown code → null', async () => {
    const db = crudDb();
    assert.equal(await deleteCoupon(db, 'GHOST'), null);
  });
});

describe('listCoupons', () => {
  test('returns all rows with their redemption counts', async () => {
    const db = crudDb({
      coupons: [d1Coupon({ synced_at: 2000 }), d1Coupon({ code: 'VIP', title: 'VIP', synced_at: 1000 })],
      redemptions: [
        { code: 'SAVE10', customer_key: 'a' },
        { code: 'SAVE10', customer_key: 'b' },
      ],
    });
    const rows = await listCoupons(db);
    assert.equal(rows.length, 2);
    const save10 = rows.find(r => r.code === 'SAVE10');
    const vip = rows.find(r => r.code === 'VIP');
    assert.equal(save10.redemption_count, 2);
    assert.equal(vip.redemption_count, 0);
  });

  test('empty table → []', async () => {
    const db = crudDb();
    assert.deepEqual(await listCoupons(db), []);
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

describe('business coupon redemptions', () => {
  test('records against a wallet top-up and can release a failed checkout reservation', async () => {
    const db = mockDb();
    const result = await recordBusinessRedemption(db, {
      topupId: 'topup-gold', code: ' biz10 ', customerKey: 'owner@example.com',
      priceBefore: 1500, discountAmount: 150, priceAfter: 1350,
    });
    assert.deepEqual(result, { recorded: true });
    const insert = db.calls.runs.find((call) => /INSERT INTO business_coupon_redemptions/.test(call.sql));
    assert.deepEqual(insert.args.slice(0, 6), ['topup-gold', 'BIZ10', 'owner@example.com', 1500, 150, 1350]);

    await releaseBusinessRedemption(db, 'topup-gold');
    const removal = db.calls.runs.find((call) => /DELETE FROM business_coupon_redemptions/.test(call.sql));
    assert.deepEqual(removal.args, ['topup-gold']);
  });
});
