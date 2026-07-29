import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  applyBusinessPlanPricing,
  businessCouponCustomerKey,
  businessMagicUrl,
  businessSessionCookie,
  BUSINESS_SESSION_TTL_MS,
  BUSINESS_PLANS,
  cancelReservedBusinessOrder,
  cancelWalletTopup,
  createWalletTopup,
  creditWalletTopup,
  estimateBusinessDeliveries,
  expireWalletCredit,
  getBusinessSession,
  hydrateBusinessProfileFromPayment,
  normalizeBusinessEmail,
  publicBusinessPlans,
  reserveWalletCredit,
  shouldHydrateBusinessProfile,
  updateReservedBusinessOrder,
  updateBusinessProfile,
} from '../src/business.js';
import { createWalletDraftOrder, parseShopifyOrderWebhook } from '../src/integrations.js';

const publicQuote = (overrides = {}) => ({
  price: 70,
  zone: 2,
  service: 'standard',
  base: 70,
  review: false,
  reasons: [],
  breakdown: {
    base: 70,
    medium_surcharge: 0,
    evening_surcharge: 0,
    weekend_multiplier: 1,
    weekend_surcharge: 0,
    total: 70,
  },
  ...overrides,
});

function walletTestDB() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE business_wallets (
      account_id INTEGER PRIMARY KEY,
      available_agorot INTEGER NOT NULL,
      reserved_agorot INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE wallet_credit_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      topup_id TEXT NOT NULL UNIQUE,
      original_agorot INTEGER NOT NULL,
      remaining_agorot INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE wallet_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      available_delta_agorot INTEGER NOT NULL DEFAULT 0,
      reserved_delta_agorot INTEGER NOT NULL DEFAULT 0,
      topup_id TEXT,
      reservation_id TEXT,
      order_id INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE wallet_reservations (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      order_id INTEGER UNIQUE,
      idempotency_key TEXT NOT NULL,
      amount_agorot INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      captured_at INTEGER,
      released_at INTEGER,
      UNIQUE(account_id, idempotency_key)
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      business_account_id INTEGER,
      business_external_id TEXT,
      wallet_reservation_id TEXT,
      name TEXT,
      phone TEXT,
      pickup TEXT,
      pickup_city TEXT,
      dropoff TEXT,
      dropoff_city TEXT,
      when_text TEXT,
      when_date TEXT,
      when_hour INTEGER,
      service TEXT,
      size TEXT,
      package TEXT,
      notes TEXT,
      price INTEGER
    );
    CREATE TABLE status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      at INTEGER NOT NULL,
      note TEXT
    );
  `);
  const wrap = (statement) => {
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
      first() { return statement.get(...values) || null; },
      all() { return { results: statement.all(...values) }; },
    };
  };
  return {
    sqlite,
    prepare(sql) { return wrap(sqlite.prepare(sql)); },
    batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

describe('business plan catalog and pricing', () => {
  test('keys one-time business coupons to the account rather than a member email', () => {
    assert.equal(businessCouponCustomerKey({ account_id: 7, email: 'owner@example.com' }), 'business:7');
    assert.equal(businessCouponCustomerKey({ account_id: 7, email: 'member@example.com' }), 'business:7');
    assert.equal(businessCouponCustomerKey({ account_id: 8, email: 'owner@example.com' }), 'business:8');
    assert.equal(businessCouponCustomerKey({ account_id: 0 }), null);
  });

  test('publishes the approved wallet commitments without exposing agorot internals', () => {
    assert.deepEqual(publicBusinessPlans().map(({ id, amount, zones }) => ({ id, amount, zones })), [
      { id: 'trial', amount: 150, zones: [1] },
      { id: 'wallet', amount: 1500, zones: [1] },
      { id: 'silver', amount: 600, zones: [1] },
      { id: 'gold', amount: 1500, zones: [1, 2] },
      { id: 'platinum', amount: 3000, zones: [1, 2, 3] },
    ]);
    assert.equal(publicBusinessPlans().find(({ id }) => id === 'gold').rates['2:standard'], 65);
    assert.equal(BUSINESS_PLANS.platinum.amount_agorot, 300_000);
    assert.equal(BUSINESS_PLANS.trial.amount_agorot, 15_000);
  });

  test('publishes a truthful value breakdown for each plan', () => {
    const plans = Object.fromEntries(publicBusinessPlans().map((plan) => [plan.id, plan]));

    assert.deepEqual(plans.trial.value.example, {
      zone: 1,
      service: 'eco',
      service_he: 'חסכוני',
      public_rate: 35,
      member_rate: 30,
      saving_per_delivery: 5,
      deliveries: 5,
      estimated_savings: 25,
      credit_remaining: 0,
    });
    assert.equal(plans.trial.value.credit_valid_days, 14);
    assert.equal(plans.trial.value.repeatable, false);
    assert.equal(plans.wallet.value.example.deliveries, 50);
    assert.equal(plans.wallet.value.example.estimated_savings, 250);
    assert.equal(plans.wallet.value.credit_valid_days, 30);
    assert.deepEqual(plans.silver.value.example, {
      zone: 1,
      service: 'standard',
      service_he: 'רגיל',
      public_rate: 50,
      member_rate: 45,
      saving_per_delivery: 5,
      deliveries: 13,
      estimated_savings: 65,
      credit_remaining: 15,
    });
    assert.equal(plans.gold.value.example.estimated_savings, 115);
    assert.equal(plans.gold.value.recommended, true);
    assert.equal(plans.platinum.value.example.estimated_savings, 308);
    assert.equal(plans.platinum.value.example.credit_remaining, 88);
    assert.equal(plans.platinum.value.credit_valid_days, 60);
    assert.equal(plans.platinum.value.max_discount_percent, 14);
  });

  test('estimates deliveries remaining from the authoritative available credit', () => {
    assert.equal(estimateBusinessDeliveries(15_000, 'trial').count, 5);
    assert.equal(estimateBusinessDeliveries(150_000, 'wallet').count, 50);
    assert.deepEqual(estimateBusinessDeliveries(60_000, 'silver'), {
      count: 13,
      rate: 45,
      zone: 1,
      service: 'standard',
      service_he: 'רגיל',
    });
    assert.equal(estimateBusinessDeliveries(55_500, 'silver').count, 12);
    assert.equal(estimateBusinessDeliveries(150_000, 'gold').count, 23);
    assert.equal(estimateBusinessDeliveries(300_000, 'platinum').count, 28);
    assert.equal(estimateBusinessDeliveries(-500, 'gold').count, 0);
    assert.equal(estimateBusinessDeliveries(60_000, 'unknown'), null);
  });

  test('applies the Gold Zone 2 member base and keeps existing surcharges', () => {
    const quote = applyBusinessPlanPricing(publicQuote({
      price: 128,
      breakdown: {
        base: 70,
        medium_surcharge: 15,
        evening_surcharge: 30,
        weekend_multiplier: 1.5,
        weekend_surcharge: 43,
        total: 128,
      },
    }), 'gold');

    assert.equal(quote.base, 65);
    assert.equal(quote.price, 165, '(₪65 + ₪15 + ₪30) × 1.5');
    assert.equal(quote.breakdown.weekend_surcharge, 55);
    assert.equal(quote.plan_id, 'gold');
  });

  test('preserves only a small urgent-work discount for Platinum Flash', () => {
    const quote = applyBusinessPlanPricing(publicQuote({ zone: 2, service: 'flash', base: 110, price: 110, breakdown: { base: 110, weekend_multiplier: 1 } }), 'platinum');
    assert.equal(quote.price, 105);
    assert.equal(quote.savings, 5);
  });

  test('rejects services outside the plan and Zone 3 Flash', () => {
    const silverZone2 = applyBusinessPlanPricing(publicQuote(), 'silver');
    const platinumZone3Flash = applyBusinessPlanPricing(publicQuote({ zone: 3, service: 'flash' }), 'platinum');
    assert.equal(silverZone2.available, false);
    assert.ok(silverZone2.reasons.includes('plan_service_unavailable'));
    assert.equal(platinumZone3Flash.available, false);
    assert.equal(applyBusinessPlanPricing(publicQuote({ zone: 1, service: 'standard' }), 'trial').available, false);
    assert.equal(applyBusinessPlanPricing(publicQuote({ zone: 1, service: 'eco', price: 35, breakdown: { base: 35, weekend_multiplier: 1 } }), 'wallet').price, 30);
  });

  test('uses the plan-specific credit expiry after a paid Shopify top-up', async () => {
    const prepared = [];
    const DB = {
      prepare(sql) {
        const statement = { sql, values: [], bind(...values) { this.values = values; prepared.push(this); return this; } };
        return statement;
      },
      async batch() { return [{ meta: { changes: 1 } }]; },
    };
    const before = Date.now();
    const result = await creditWalletTopup(DB, {
      id: 'trial-topup', account_id: 7, plan_id: 'trial', amount_agorot: 15_000,
      currency: 'ILS', status: 'checkout_ready', shopify_draft_order_id: '44',
    }, { paid: true, total: 150, currency: 'ILS', draftOrderId: '44', shopifyOrderId: '99' });
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    assert.ok(result.expires_at >= before + fourteenDays);
    assert.ok(result.expires_at <= Date.now() + fourteenDays);
    assert.ok(prepared.some(({ sql, values }) => sql.includes('wallet_credit_lots') && values[0] === result.expires_at));
  });

  test('validates a replayed paid webhook before allowing profile hydration', async () => {
    const topup = {
      id: 'paid-topup', account_id: 7, plan_id: 'trial', amount_agorot: 15_000,
      currency: 'ILS', status: 'paid', shopify_draft_order_id: '44', shopify_order_id: '99',
    };
    const valid = await creditWalletTopup(null, topup, {
      paid: true, total: 150, currency: 'ILS', draftOrderId: '44', shopifyOrderId: '99',
    });
    const pending = await creditWalletTopup(null, topup, {
      paid: false, total: 150, currency: 'ILS', draftOrderId: '44', shopifyOrderId: '99',
    });
    const wrongOrder = await creditWalletTopup(null, topup, {
      paid: true, total: 150, currency: 'ILS', draftOrderId: '44', shopifyOrderId: '100',
    });
    assert.equal(valid.paymentValidated, true);
    assert.equal(shouldHydrateBusinessProfile(valid), false, 'a paid webhook replay must not restore cleared profile fields');
    assert.equal(pending.paymentValidated, false);
    assert.equal(wrongOrder.paymentValidated, false);
  });

  test('accepts a ₪130 discounted payment and credits the full ₪150 plan value', async () => {
    const prepared = [];
    const DB = {
      prepare(sql) {
        const statement = { sql, values: [], bind(...values) { this.values = values; prepared.push(this); return this; } };
        return statement;
      },
      async batch() { return [{ meta: { changes: 1 } }]; },
    };
    const result = await creditWalletTopup(DB, {
      id: 'discounted-trial', account_id: 7, plan_id: 'trial', amount_agorot: 15_000,
      payment_amount_agorot: 13_000, currency: 'ILS', status: 'checkout_ready', shopify_draft_order_id: '44',
    }, { paid: true, total: 130, currency: 'ILS', draftOrderId: '44', shopifyOrderId: '100' });
    assert.equal(result.credited, true);
    const walletCredit = prepared.find(({ sql }) => /SET available_agorot = available_agorot \+ \?/.test(sql));
    assert.equal(walletCredit.values[0], 15_000);
  });

  test('hydrates billing profile only on the first validated wallet credit', () => {
    assert.equal(shouldHydrateBusinessProfile({ paymentValidated: true, credited: true }), true);
    assert.equal(shouldHydrateBusinessProfile({ paymentValidated: true, credited: true, unchanged: true }), false);
    assert.equal(shouldHydrateBusinessProfile({ paymentValidated: false, credited: false }), false);
  });

  test('enforces one Trial checkout per account at the domain boundary', async () => {
    const prepared = [];
    const DB = {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) { this.values = values; prepared.push(this); return this; },
          async run() { return { meta: { changes: 0 } }; },
          async first() { return null; },
        };
        return statement;
      },
    };
    const result = await createWalletTopup(DB, { account_id: 7, email: 'owner@example.com' }, 'trial');
    assert.deepEqual(result, { error: 'trial_already_used' });
    assert.ok(prepared.some(({ sql, values }) => sql.includes("SET status = 'cancelled'") && values[0] === 7 && values[1] === 'trial'));
    assert.ok(prepared.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO wallet_topups')));
  });

  test('cancels an unstarted top-up so failed checkout creation can be retried', async () => {
    let statement;
    const DB = {
      prepare(sql) {
        statement = { sql, values: [], bind(...values) { this.values = values; return this; }, async run() { return { meta: { changes: 1 } }; } };
        return statement;
      },
    };
    await cancelWalletTopup(DB, 'trial-topup');
    assert.match(statement.sql, /status = 'cancelled'.*status = 'created'/);
    assert.deepEqual(statement.values, ['trial-topup']);
  });

  test('snapshots a ₪20 business coupon while preserving the ₪150 plan credit', async () => {
    const prepared = [];
    const DB = {
      prepare(sql) {
        const statement = {
          sql, values: [], bind(...values) { this.values = values; prepared.push(this); return this; },
          async run() { return { meta: { changes: 1 } }; },
          async first() { return /INSERT OR IGNORE INTO wallet_topups/.test(sql) ? { id: 'created' } : null; },
        };
        return statement;
      },
    };
    const coupon = { code: 'BIZ20', title: '₪20 business discount', subtotal: 150, discountAmount: 20, price: 130 };
    const topup = await createWalletTopup(DB, { account_id: 7, email: 'owner@example.com' }, 'trial', coupon);
    assert.equal(topup.amount, 130);
    assert.equal(topup.subtotal, 150);
    assert.equal(topup.credit_amount, 150);
    assert.equal(topup.discount_code, 'BIZ20');
    const insert = prepared.find(({ sql }) => /INSERT OR IGNORE INTO wallet_topups/.test(sql));
    assert.equal(insert.values[3], 15_000, 'wallet credit remains the full plan value');
    assert.equal(insert.values[4], 13_000, 'payment reconciliation uses the discounted total');
    assert.equal(insert.values[6], 2_000);
  });
});

describe('business wallet credit expiry', () => {
  test('posts unused expired credit once and leaves active credit available', async () => {
    const DB = walletTestDB();
    const now = 1_000_000;
    DB.sqlite.prepare('INSERT INTO business_wallets VALUES (?, ?, ?, ?, ?)').run(7, 15_000, 0, 0, now - 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(7, 'expired', 10_000, 10_000, now, 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(7, 'active', 5_000, 5_000, now + 10_000, 2);

    const first = await expireWalletCredit(DB, 7, now);
    const second = await expireWalletCredit(DB, 7, now + 1);
    const wallet = DB.sqlite.prepare('SELECT * FROM business_wallets WHERE account_id = 7').get();
    const lots = DB.sqlite.prepare('SELECT topup_id, remaining_agorot FROM wallet_credit_lots ORDER BY id').all().map((lot) => ({ ...lot }));
    const entries = DB.sqlite.prepare("SELECT entry_type, available_delta_agorot FROM wallet_entries WHERE entry_type = 'expiry'").all().map((entry) => ({ ...entry }));

    assert.deepEqual(first, { expired_agorot: 10_000 });
    assert.deepEqual(second, { expired_agorot: 0 });
    assert.equal(wallet.available_agorot, 5_000);
    assert.equal(wallet.reserved_agorot, 0);
    assert.deepEqual(lots, [
      { topup_id: 'expired', remaining_agorot: 0 },
      { topup_id: 'active', remaining_agorot: 5_000 },
    ]);
    assert.deepEqual(entries, [{ entry_type: 'expiry', available_delta_agorot: -10_000 }]);
  });

  test('protects expired credit already reserved for an existing delivery', async () => {
    const DB = walletTestDB();
    const now = 2_000_000;
    DB.sqlite.prepare('INSERT INTO business_wallets VALUES (?, ?, ?, ?, ?)').run(8, 10_000, 5_000, 0, now - 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(8, 'expired', 10_000, 10_000, now, 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(8, 'active', 5_000, 5_000, now + 10_000, 2);

    const result = await expireWalletCredit(DB, 8, now);
    const wallet = DB.sqlite.prepare('SELECT * FROM business_wallets WHERE account_id = 8').get();
    const lots = DB.sqlite.prepare('SELECT topup_id, remaining_agorot FROM wallet_credit_lots ORDER BY id').all().map((lot) => ({ ...lot }));

    assert.deepEqual(result, { expired_agorot: 5_000 });
    assert.equal(wallet.available_agorot, 5_000);
    assert.equal(wallet.reserved_agorot, 5_000);
    assert.deepEqual(lots, [
      { topup_id: 'expired', remaining_agorot: 5_000 },
      { topup_id: 'active', remaining_agorot: 5_000 },
    ]);
  });

  test('expires stale credit before deciding whether a new reservation can be funded', async () => {
    const DB = walletTestDB();
    const now = Date.now();
    DB.sqlite.prepare('INSERT INTO business_wallets VALUES (?, ?, ?, ?, ?)').run(9, 10_000, 0, 0, now - 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(9, 'expired', 6_000, 6_000, now - 1, 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(9, 'active', 4_000, 4_000, now + 10_000, 2);

    const result = await reserveWalletCredit(DB, 9, 5_000, 'booking-1');

    assert.equal(result.reserved, false);
    assert.equal(result.available_agorot, 4_000);
    assert.equal(result.shortfall_agorot, 1_000);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM wallet_reservations').get().count, 0);
  });

  test('fails closed instead of spending when stored wallet totals are inconsistent', async () => {
    const DB = walletTestDB();
    const now = 3_000_000;
    DB.sqlite.prepare('INSERT INTO business_wallets VALUES (?, ?, ?, ?, ?)').run(10, 4_000, 5_000, 0, now - 1);
    DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(10, 'expired', 10_000, 10_000, now, 1);

    await assert.rejects(
      () => expireWalletCredit(DB, 10, now),
      /wallet_expiry_invariant_failed/,
    );
    assert.equal(DB.sqlite.prepare('SELECT available_agorot FROM business_wallets WHERE account_id = 10').get().available_agorot, 4_000);
    assert.equal(DB.sqlite.prepare('SELECT remaining_agorot FROM wallet_credit_lots WHERE account_id = 10').get().remaining_agorot, 10_000);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM wallet_entries').get().count, 0);
  });
});

describe('business batch order credit adjustments', () => {
  function reservedOrderDB() {
    const DB = walletTestDB();
    DB.sqlite.prepare('INSERT INTO business_wallets VALUES (?, ?, ?, ?, ?)').run(
      12,
      10_000,
      5_000,
      0,
      1,
    );
    DB.sqlite.prepare(`INSERT INTO wallet_reservations
      (id, account_id, order_id, idempotency_key, amount_agorot, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'reserved', ?)`)
      .run('reservation-12', 12, 90, 'batch-external:key', 5_000, 1);
    DB.sqlite.prepare(`INSERT INTO orders
      (id, status, payment_status, business_account_id, business_external_id,
       wallet_reservation_id, name, phone, pickup, pickup_city, dropoff,
       dropoff_city, when_text, when_date, when_hour, service, size, package,
       notes, price)
      VALUES (?, 'paid', 'wallet_reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?)`)
      .run(
        90,
        12,
        'ORD-90',
        'reservation-12',
        'Old name',
        '+972501111111',
        'Pickup 1',
        'תל אביב',
        'Dropoff 1',
        'רמת גן',
        '2026-08-02 · 10:00',
        '2026-08-02',
        10,
        'standard',
        'small',
        'Documents',
        '',
        50,
      );
    return DB;
  }

  const changedOrder = {
    name: 'New name',
    phone: '+972502222222',
    pickup: 'Pickup 1',
    pickup_city: 'תל אביב',
    dropoff: 'Dropoff 2',
    dropoff_city: 'גבעתיים',
    when_text: '2026-08-03 · 11:00',
    when_date: '2026-08-03',
    when_hour: 11,
    service: 'standard',
    size: 'medium',
    package: 'Documents',
    notes: 'Call',
    price: 65,
    business_external_id: 'ORD-90',
  };

  test('updates one reserved order and adjusts only the credit difference', async () => {
    const DB = reservedOrderDB();
    const result = await updateReservedBusinessOrder(DB, {
      accountId: 12,
      orderId: 90,
      reservationId: 'reservation-12',
      amountAgorot: 6_500,
      adjustmentKey: 'batch-adjust-90-1',
      order: changedOrder,
    });

    assert.equal(result.updated, true);
    assert.deepEqual(
      { ...DB.sqlite.prepare(
        'SELECT available_agorot, reserved_agorot FROM business_wallets WHERE account_id = 12'
      ).get() },
      { available_agorot: 8_500, reserved_agorot: 6_500 },
    );
    assert.deepEqual(
      { ...DB.sqlite.prepare(
        'SELECT amount_agorot, status FROM wallet_reservations WHERE id = ?'
      ).get('reservation-12') },
      { amount_agorot: 6_500, status: 'reserved' },
    );
    assert.deepEqual(
      { ...DB.sqlite.prepare(
        'SELECT name, dropoff, price, business_external_id FROM orders WHERE id = 90'
      ).get() },
      {
        name: 'New name',
        dropoff: 'Dropoff 2',
        price: 65,
        business_external_id: 'ORD-90',
      },
    );
    assert.deepEqual(
      { ...DB.sqlite.prepare(
        'SELECT available_delta_agorot, reserved_delta_agorot FROM wallet_entries'
      ).get() },
      { available_delta_agorot: -1_500, reserved_delta_agorot: 1_500 },
    );
  });

  test('does not change the order when an update needs more credit than is available', async () => {
    const DB = reservedOrderDB();
    const result = await updateReservedBusinessOrder(DB, {
      accountId: 12,
      orderId: 90,
      reservationId: 'reservation-12',
      amountAgorot: 20_000,
      adjustmentKey: 'batch-adjust-90-insufficient',
      order: { ...changedOrder, price: 200 },
    });

    assert.equal(result.updated, false);
    assert.equal(result.error, 'insufficient_credit');
    assert.equal(DB.sqlite.prepare('SELECT price FROM orders WHERE id = 90').get().price, 50);
    assert.equal(
      DB.sqlite.prepare(
        'SELECT amount_agorot FROM wallet_reservations WHERE id = ?'
      ).get('reservation-12').amount_agorot,
      5_000,
    );
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM wallet_entries').get().count, 0);
  });

  test('records a new ledger transition when an older signed update is reused after another edit', async () => {
    const DB = reservedOrderDB();
    const adjustmentKey = 'same-signed-batch-token';
    const first = await updateReservedBusinessOrder(DB, {
      accountId: 12,
      orderId: 90,
      reservationId: 'reservation-12',
      amountAgorot: 6_000,
      adjustmentKey,
      order: { ...changedOrder, price: 60 },
    });
    const second = await updateReservedBusinessOrder(DB, {
      accountId: 12,
      orderId: 90,
      reservationId: 'reservation-12',
      amountAgorot: 7_000,
      adjustmentKey,
      order: { ...changedOrder, name: 'Newest name', price: 70 },
    });

    assert.equal(first.updated, true);
    assert.equal(second.updated, true);
    assert.deepEqual(
      { ...DB.sqlite.prepare(
        'SELECT available_agorot, reserved_agorot FROM business_wallets WHERE account_id = 12'
      ).get() },
      { available_agorot: 8_000, reserved_agorot: 7_000 },
    );
    assert.equal(
      DB.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM wallet_entries WHERE entry_type = 'adjustment'"
      ).get().count,
      2,
    );
    assert.equal(DB.sqlite.prepare('SELECT name FROM orders WHERE id = 90').get().name, 'Newest name');
  });

  test('cancels before dispatch and releases the held credit exactly once', async () => {
    const DB = reservedOrderDB();
    const first = await cancelReservedBusinessOrder(DB, 12, 90);
    const second = await cancelReservedBusinessOrder(DB, 12, 90);

    assert.deepEqual(first, { cancelled: true, released_agorot: 5_000 });
    assert.deepEqual(second, { cancelled: false, error: 'existing_order_locked' });
    assert.deepEqual(
      { ...DB.sqlite.prepare(
        'SELECT available_agorot, reserved_agorot FROM business_wallets WHERE account_id = 12'
      ).get() },
      { available_agorot: 15_000, reserved_agorot: 0 },
    );
    assert.deepEqual(
      { ...DB.sqlite.prepare('SELECT status, payment_status FROM orders WHERE id = 90').get() },
      { status: 'cancelled', payment_status: 'wallet_released' },
    );
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM wallet_entries').get().count, 1);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM status_history').get().count, 1);
  });
});

describe('business passwordless authentication helpers', () => {
  test('normalizes valid email and rejects malformed values', () => {
    assert.equal(normalizeBusinessEmail('  Owner@Example.COM '), 'owner@example.com');
    assert.equal(normalizeBusinessEmail('missing-at.example.com'), null);
  });

  test('uses a secure, HttpOnly, same-site three-day session cookie', () => {
    const cookie = businessSessionCookie('opaque-token');
    assert.match(cookie, /^business_session=opaque-token;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=259200/);
    assert.equal(BUSINESS_SESSION_TTL_MS, 3 * 24 * 60 * 60 * 1000);
  });

  test('caps previously issued business sessions at the current three-day policy', async () => {
    let sql = '';
    let values = [];
    const DB = {
      prepare(statement) {
        sql = statement;
        return {
          bind(...bound) {
            values = bound;
            return { first: async () => null };
          },
        };
      },
    };
    const before = Date.now();
    await getBusinessSession(
      new Request('https://find.edenmish.com/api/business/me', {
        headers: { Cookie: 'business_session=opaque-token' },
      }),
      { DB, SESSION_SECRET: 'test-session-secret-that-is-long-enough' },
    );
    const after = Date.now();
    assert.match(sql, /s\.expires_at > \? AND s\.created_at >= \?/);
    assert.equal(values.length, 3);
    assert.ok(values[1] >= before && values[1] <= after);
    assert.equal(values[1] - values[2], BUSINESS_SESSION_TTL_MS);
  });

  test('preserves the selected plan in emailed magic links', () => {
    const url = new URL(businessMagicUrl('https://find.edenmish.com/business?plan=trial', 'challenge-1', 'token-1'));
    assert.equal(url.pathname, '/business');
    assert.equal(url.searchParams.get('plan'), 'trial');
    assert.equal(url.searchParams.get('challenge'), 'challenge-1');
    assert.equal(url.searchParams.get('token'), 'token-1');
  });
});

describe('Shopify business wallet boundary', () => {
  test('parses a wallet top-up token independently of a delivery tracking token', () => {
    const line = parseShopifyOrderWebhook({
      financial_status: 'paid',
      line_items: [{ properties: [{ name: '_edenmish_wallet_topup', value: 'topup_abc' }] }],
    });
    const meta = parseShopifyOrderWebhook({
      metafields: [{ namespace: 'edenmish', key: 'wallet_topup_token', value: 'topup_meta' }],
    });
    const note = parseShopifyOrderWebhook({ note: 'EdenMish wallet topup: topup-note_1' });
    assert.equal(line.walletTopupToken, 'topup_abc');
    assert.equal(line.token, null);
    assert.equal(meta.walletTopupToken, 'topup_meta');
    assert.equal(note.walletTopupToken, 'topup-note_1');
  });

  test('fills empty business details from a verified payment without replacing saved values', async () => {
    const prepared = [];
    const DB = {
      prepare(sql) {
        const statement = { sql, values: [], bind(...values) { this.values = values; prepared.push(this); return this; } };
        return statement;
      },
      async batch() { return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]; },
    };
    const result = await hydrateBusinessProfileFromPayment(DB, 7, {
      billingCompany: 'Eden Mish Ltd',
      customerName: 'Eden Arieli',
      customerPhone: '0501234567',
      email: 'owner@example.com',
    });
    assert.equal(result.updated, true);
    assert.match(prepared[0].sql, /COALESCE\(NULLIF\(TRIM\(company_name\)/);
    assert.match(prepared[1].sql, /email = \?.*business_members/s);
    assert.deepEqual(prepared[0].values, ['Eden Mish Ltd', prepared[0].values[1], 7]);
    assert.deepEqual(prepared[1].values, ['Eden Arieli', '0501234567', prepared[1].values[2], 'owner@example.com', 7]);
  });

  test('updates only profile fields present in a customer patch', async () => {
    const prepared = [];
    const DB = {
      prepare(sql) {
        const statement = { sql, values: [], bind(...values) { this.values = values; prepared.push(this); return this; } };
        return statement;
      },
      async batch(statements) { return statements.map(() => ({ meta: { changes: 1 } })); },
    };
    const result = await updateBusinessProfile(DB, { account_id: 7, user_id: 9 }, { company_name: 'New Name' });
    assert.equal(prepared.length, 1);
    assert.match(prepared[0].sql, /UPDATE business_accounts/);
    assert.deepEqual(result, { company_name: 'New Name', name: undefined, phone: undefined });
  });

  test('creates a non-shipping Draft Order with wallet-only correlation metadata', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/44', legacyResourceId: '44', invoiceUrl: 'https://shop.example/invoice/44' }, userErrors: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const draft = await createWalletDraftOrder({
        SHOPIFY_SHOP: 'example.myshopify.com',
        SHOPIFY_ADMIN_TOKEN: 'placeholder-for-test',
        SHOPIFY_API_VERSION: '2026-04',
      }, { id: 'topup-44', plan_id: 'gold', plan_name_he: 'זהב', email: 'owner@example.com' }, 1500);
      assert.equal(draft.id, '44');
      assert.ok(String(request.url).endsWith('/graphql.json'));
      const body = JSON.parse(request.options.body).variables.input;
      assert.equal(body.lineItems[0].variantId, 'gid://shopify/ProductVariant/52017115070781');
      assert.equal(body.lineItems[0].priceOverride.amount, '1500.00');
      assert.deepEqual(body.lineItems[0].customAttributes[0], { key: '_edenmish_wallet_topup', value: 'topup-44' });
      assert.deepEqual(body.tags, ['edenmish-wallet-topup']);
      assert.equal(body.email, 'owner@example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps every business plan to its image-bearing Shopify variant', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/45', legacyResourceId: '45', invoiceUrl: 'https://shop.example/invoice/45' }, userErrors: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const variants = {
      trial: 'gid://shopify/ProductVariant/52017114972477',
      wallet: 'gid://shopify/ProductVariant/52017115005245',
      silver: 'gid://shopify/ProductVariant/52017115038013',
      gold: 'gid://shopify/ProductVariant/52017115070781',
      platinum: 'gid://shopify/ProductVariant/52017115103549',
    };
    try {
      for (const [planId, variantId] of Object.entries(variants)) {
        await createWalletDraftOrder({
          SHOPIFY_SHOP: 'example.myshopify.com',
          SHOPIFY_ADMIN_TOKEN: 'placeholder-for-test',
        }, { id: `topup-${planId}`, plan_id: planId, plan_name_he: planId }, 150);
        const input = JSON.parse(request.options.body).variables.input;
        assert.equal(input.lineItems[0].variantId, variantId);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shows ₪150 less ₪20 as an applied Shopify checkout discount', async () => {
    const originalFetch = globalThis.fetch;
    let input;
    globalThis.fetch = async (url, options) => {
      input = JSON.parse(options.body).variables.input;
      return new Response(JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/46', legacyResourceId: '46', invoiceUrl: 'https://shop.example/invoice/46' }, userErrors: [] } } }), { status: 200 });
    };
    try {
      await createWalletDraftOrder({ SHOPIFY_SHOP: 'example.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'test' }, {
        id: 'topup-discount', plan_id: 'trial', plan_name_he: 'ניסיון', subtotal: 150,
        credit_amount: 150, discount_code: 'BIZ20', discount_amount: 20,
      }, 130);
      assert.equal(input.lineItems[0].priceOverride.amount, '150.00');
      assert.equal(input.appliedDiscount.title, 'BIZ20');
      assert.equal(input.appliedDiscount.amountWithCurrency.amount, '20.00');
      assert.equal(input.lineItems[0].customAttributes.find(({ key }) => key === 'יתרה').value, '₪150');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
