import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { priceOrder } from '../src/pricing.js';
import { parseShopifyOrderWebhook } from '../src/integrations.js';
import { corsFor, maskEmail } from '../src/security.js';

describe('priceOrder', () => {
  test('uses the highest route zone and the standard defaults', () => {
    const result = priceOrder({
      pickup_city: 'תל אביב',
      dropoff_city: 'חולון',
      service: 'standard',
      size: 'small',
      when_date: '2026-07-10',
      when_hour: 12,
    });

    assert.deepEqual(result, {
      price: 70, zone: 2, service: 'standard', size: 'small', base: 70,
      review: false, reasons: [],
      breakdown: {
        base: 70,
        medium_surcharge: 0,
        evening_surcharge: 0,
        weekend_multiplier: 1,
        weekend_surcharge: 0,
        total: 70,
      },
    });
  });

  test('applies medium, evening, and Saturday adjustments in order', () => {
    const result = priceOrder({
      pickup_city: 'תל אביב', dropoff_city: 'רמת גן',
      service: 'standard', size: 'medium', when_date: '2026-07-11', when_hour: 19,
    });

    assert.equal(result.base, 50);
    assert.equal(result.price, 143, '(₪50 + ₪15 + ₪30) × 1.5 rounds to ₪143');
    assert.equal(result.review, false);
    assert.deepEqual(result.breakdown, {
      base: 50,
      medium_surcharge: 15,
      evening_surcharge: 30,
      weekend_multiplier: 1.5,
      weekend_surcharge: 48,
      total: 143,
    });
  });

  test('keeps Friday at the weekday price', () => {
    const result = priceOrder({
      pickup_city: 'תל אביב', dropoff_city: 'רמת גן',
      service: 'eco', size: 'small', when_date: '2026-07-10', when_hour: 12,
    });
    assert.equal(result.price, 35);
  });

  test('flags Flash zone 3 and falls back to the configured standard zone 1 price', () => {
    const result = priceOrder({
      pickup_city: 'תל אביב', dropoff_city: 'רעננה', service: 'flash', size: 'small',
    }, { std_z1: '62' });

    assert.equal(result.price, 62);
    assert.equal(result.zone, 3);
    assert.equal(result.base, null);
    assert.equal(result.review, true);
    assert.deepEqual(result.reasons, ['flash_unavailable_z3']);
  });

  test('flags unknown cities while returning a safe fallback quote', () => {
    const result = priceOrder({ pickup_city: 'חיפה', dropoff_city: 'רמת גן' });
    assert.equal(result.price, 50);
    assert.equal(result.zone, null);
    assert.equal(result.review, true);
    assert.deepEqual(result.reasons, ['out_of_zone']);
  });
});

describe('parseShopifyOrderWebhook', () => {
  test('prefers the line-item tracking token and maps paid checkout details', () => {
    const result = parseShopifyOrderWebhook({
      id: 9001,
      draft_order_id: 8001,
      financial_status: ' PAID ',
      total_price: '50.00',
      currency: 'ILS',
      email: 'checkout@example.com',
      customer: { first_name: 'Test', last_name: 'Customer', phone: '0501111111' },
      billing_address: { company: 'Test Delivery Ltd' },
      line_items: [{ properties: [{ name: '_tracking_token', value: 'line-token' }] }],
      metafields: [{ namespace: 'edenmish', key: 'tracking_token', value: 'meta-token' }],
      note: 'token: deadbeef',
    });

    assert.equal(result.token, 'line-token');
    assert.equal(result.shopifyOrderId, 9001);
    assert.equal(result.draftOrderId, 8001);
    assert.equal(result.paid, true);
    assert.equal(result.total, '50.00');
    assert.equal(result.currency, 'ILS');
    assert.equal(result.email, 'checkout@example.com');
    assert.equal(result.customerName, 'Test Customer');
    assert.equal(result.customerPhone, '0501111111');
    assert.equal(result.billingCompany, 'Test Delivery Ltd');
  });

  test('parses a redelivery charge independently from the original tracking token', () => {
    const line = parseShopifyOrderWebhook({
      line_items: [{
        properties: [
          { name: '_tracking_token', value: 'tracking-token' },
          { name: '_edenmish_redelivery_charge', value: 'rdl_line' },
        ],
      }],
    });
    const meta = parseShopifyOrderWebhook({
      metafields: [{
        namespace: 'edenmish',
        key: 'redelivery_charge_id',
        value: 'rdl_meta',
      }],
    });
    const note = parseShopifyOrderWebhook({
      note: 'EdenMish redelivery charge: rdl_note-1',
    });

    assert.equal(line.token, 'tracking-token');
    assert.equal(line.redeliveryChargeId, 'rdl_line');
    assert.equal(meta.redeliveryChargeId, 'rdl_meta');
    assert.equal(note.redeliveryChargeId, 'rdl_note-1');
  });

  test('falls back to the EdenMish metafield and then the note token', () => {
    const meta = parseShopifyOrderWebhook({
      metafields: [{ namespace: 'edenmish', key: 'tracking_token', value: 'meta-token' }],
      note: 'token: deadbeef',
    });
    const note = parseShopifyOrderWebhook({ note: 'EdenMish token: A1b2C3d4' });

    assert.equal(meta.token, 'meta-token');
    assert.equal(note.token, 'A1b2C3d4');
  });

  test('only treats the exact paid financial status as captured', () => {
    for (const status of ['pending', 'authorized', 'partially_paid', 'voided', 'refunded', 'partially_refunded', '']) {
      assert.equal(parseShopifyOrderWebhook({ financial_status: status }).paid, false, status);
    }
  });

  test('uses presentment currency and customer email fallbacks', () => {
    const result = parseShopifyOrderWebhook({
      presentment_currency: 'ILS',
      customer: { first_name: 'Dana', last_name: 'Levi', email: 'dana@example.com' },
    });
    assert.equal(result.currency, 'ILS');
    assert.equal(result.email, 'dana@example.com');
    assert.equal(result.customerName, 'Dana Levi');
  });

  test('uses billing details when Shopify does not attach a named customer', () => {
    const result = parseShopifyOrderWebhook({
      billing_address: {
        first_name: 'Noa',
        last_name: 'Cohen',
        phone: '0522222222',
        company: 'Noa Studio',
      },
    });
    assert.equal(result.customerName, 'Noa Cohen');
    assert.equal(result.customerPhone, '0522222222');
    assert.equal(result.billingCompany, 'Noa Studio');
  });
});

describe('corsFor', () => {
  const request = (origin) => new Request('https://find.edenmish.com/health', {
    headers: origin ? { Origin: origin } : {},
  });

  test('uses the backward-compatible wildcard when no allowlist is configured', () => {
    const headers = corsFor(request(), {});
    assert.equal(headers['Access-Control-Allow-Origin'], '*');
    assert.equal(headers['Access-Control-Allow-Credentials'], undefined);
  });

  test('reflects an exact allowlisted origin with credential and cache headers', () => {
    const headers = corsFor(request('https://edenmish.com'), {
      ALLOWED_ORIGINS: 'https://edenmish.com, https://staging.edenmish.com',
    });
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://edenmish.com');
    assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
    assert.match(headers['Access-Control-Allow-Headers'], /Idempotency-Key/);
    assert.equal(headers.Vary, 'Origin');
  });

  test('allows only HTTPS subdomains for wildcard preview rules', () => {
    const env = { ALLOWED_ORIGINS: 'https://*.edenmish-staging.pages.dev' };
    assert.equal(corsFor(request('https://fix-otp.edenmish-staging.pages.dev'), env)['Access-Control-Allow-Origin'], 'https://fix-otp.edenmish-staging.pages.dev');
    for (const origin of [
      'https://edenmish-staging.pages.dev',
      'http://fix-otp.edenmish-staging.pages.dev',
      'https://fix-otp.edenmish-staging.pages.dev.attacker.example',
      'https://fix-otp.edenmish-staging.pages.dev:444',
    ]) {
      assert.equal(corsFor(request(origin), env)['Access-Control-Allow-Origin'], undefined, origin);
    }
  });

  test('omits the readable origin header for a rejected origin', () => {
    const headers = corsFor(request('https://attacker.example'), { ALLOWED_ORIGINS: 'https://edenmish.com' });
    assert.equal(headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(headers.Vary, 'Origin');
  });
});

describe('maskEmail', () => {
  test('masks the local part and domain while preserving the final suffix', () => {
    assert.equal(maskEmail('john@example.com'), 'j•••@e•••.com');
    assert.equal(maskEmail('a@localhost'), 'a•••@l•••');
  });

  test('returns null for missing or malformed addresses', () => {
    for (const email of [null, '', 'missing-at-sign', '@example.com']) {
      assert.equal(maskEmail(email), null);
    }
  });
});
