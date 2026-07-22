import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBusinessPlanPricing,
  businessMagicUrl,
  businessSessionCookie,
  BUSINESS_SESSION_TTL_MS,
  BUSINESS_PLANS,
  cancelWalletTopup,
  createWalletTopup,
  creditWalletTopup,
  estimateBusinessDeliveries,
  getBusinessSession,
  hydrateBusinessProfileFromPayment,
  normalizeBusinessEmail,
  publicBusinessPlans,
  shouldHydrateBusinessProfile,
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

describe('business plan catalog and pricing', () => {
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
      return new Response(JSON.stringify({ draft_order: { id: 44, invoice_url: 'https://shop.example/invoice/44' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const draft = await createWalletDraftOrder({
        SHOPIFY_SHOP: 'example.myshopify.com',
        SHOPIFY_ADMIN_TOKEN: 'placeholder-for-test',
        SHOPIFY_API_VERSION: '2026-04',
      }, { id: 'topup-44', plan_id: 'gold', plan_name_he: 'זהב', email: 'owner@example.com' }, 1500);
      assert.equal(draft.id, 44);
      const body = JSON.parse(request.options.body).draft_order;
      assert.equal(body.line_items[0].requires_shipping, false);
      assert.equal(body.line_items[0].price, '1500.00');
      assert.deepEqual(body.line_items[0].properties[0], { name: '_edenmish_wallet_topup', value: 'topup-44' });
      assert.equal(body.tags, 'edenmish-wallet-topup');
      assert.equal(body.customer.email, 'owner@example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
