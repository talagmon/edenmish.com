import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBusinessPlanPricing,
  businessSessionCookie,
  BUSINESS_PLANS,
  normalizeBusinessEmail,
  publicBusinessPlans,
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
      { id: 'silver', amount: 600, zones: [1] },
      { id: 'gold', amount: 1500, zones: [1, 2] },
      { id: 'platinum', amount: 3000, zones: [1, 2, 3] },
    ]);
    assert.equal(publicBusinessPlans().find(({ id }) => id === 'gold').rates['2:standard'], 65);
    assert.equal(BUSINESS_PLANS.platinum.amount_agorot, 300_000);
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
  });
});

describe('business passwordless authentication helpers', () => {
  test('normalizes valid email and rejects malformed values', () => {
    assert.equal(normalizeBusinessEmail('  Owner@Example.COM '), 'owner@example.com');
    assert.equal(normalizeBusinessEmail('missing-at.example.com'), null);
  });

  test('uses a secure, HttpOnly, same-site 30-day session cookie', () => {
    const cookie = businessSessionCookie('opaque-token');
    assert.match(cookie, /^business_session=opaque-token;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=2592000/);
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
