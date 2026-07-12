import { test, describe } from 'node:test';
import assert from 'node:assert';
import { priceOrder, zoneOf } from '../../worker/src/pricing.js';

// ============================================================
// PRICING ENGINE TESTS
// The storefront suite imports the Worker's pricing source of truth directly.
// It must never carry a second copy of zones, rates, or surcharge arithmetic.
// ============================================================

// --- Helpers ---
const std = (pickup, dropoff, opts = {}) =>
  priceOrder({ pickup_city: pickup, dropoff_city: dropoff, service: 'standard', size: 'small', ...opts });

describe('Pricing: Base matrix (small, no surcharges)', () => {
  test('Standard Zone 1 (TLV→Ramat Gan) = ₪50', () => {
    const r = std('תל אביב', 'רמת גן');
    assert.strictEqual(r.price, 50);
    assert.strictEqual(r.zone, 1);
    assert.strictEqual(r.review, false);
  });

  test('Standard Zone 2 (TLV→Holon) = ₪70', () => {
    const r = std('תל אביב', 'חולון');
    assert.strictEqual(r.price, 70);
    assert.strictEqual(r.zone, 2);
  });

  test('Standard Zone 3 (TLV→Rishon) = ₪115', () => {
    const r = std('תל אביב', 'ראשון לציון');
    assert.strictEqual(r.price, 115);
    assert.strictEqual(r.zone, 3);
  });

  test('Eco Zone 1 = ₪35', () => {
    assert.strictEqual(std('תל אביב', 'בני ברק', { service: 'eco' }).price, 35);
  });

  test('Eco Zone 3 = ₪75', () => {
    assert.strictEqual(std('תל אביב', 'פתח תקווה', { service: 'eco' }).price, 75);
  });

  test('Flash Zone 1 = ₪85', () => {
    assert.strictEqual(std('תל אביב', 'רמת גן', { service: 'flash' }).price, 85);
  });

  test('Flash Zone 2 = ₪110', () => {
    assert.strictEqual(std('תל אביב', 'חולון', { service: 'flash' }).price, 110);
  });

  test('Zone = max(pickup, dropoff) — pickup Z1 + dropoff Z3 → Zone 3', () => {
    const r = std('תל אביב', 'ראשון לציון');
    assert.strictEqual(r.zone, 3);
    assert.strictEqual(r.price, 115);
  });
});

describe('Pricing: Surcharges', () => {
  test('Medium size adds ₪15', () => {
    const r = std('תל אביב', 'רמת גן', { size: 'medium' });
    assert.strictEqual(r.price, 65); // 50 + 15
  });

  test('Evening pickup (19:00-22:00) adds ₪30', () => {
    const r = std('תל אביב', 'רמת גן', { when_hour: 20 });
    assert.strictEqual(r.price, 80); // 50 + 30
  });

  test('Evening boundary: 18:00 → no surcharge', () => {
    const r = std('תל אביב', 'רמת גן', { when_hour: 18 });
    assert.strictEqual(r.price, 50);
  });

  test('Evening boundary: 22:00 → no surcharge', () => {
    const r = std('תל אביב', 'רמת גן', { when_hour: 22 });
    assert.strictEqual(r.price, 50);
  });

  test('Friday → no weekend multiplier (regular work day in Israel)', () => {
    // 2026-07-03 is a Friday
    const r = std('תל אביב', 'רמת גן', { when_date: '2026-07-03' });
    assert.strictEqual(r.price, 50); // regular price, no multiplier
  });

  test('Saturday ×1.5 multiplier', () => {
    // 2026-07-04 is a Saturday
    const r = std('תל אביב', 'רמת גן', { when_date: '2026-07-04' });
    assert.strictEqual(r.price, 75);
  });

  test('Sunday → no weekend multiplier', () => {
    // 2026-07-05 is a Sunday
    const r = std('תל אביב', 'רמת גן', { when_date: '2026-07-05' });
    assert.strictEqual(r.price, 50);
  });

  test('Medium + evening + Friday (no weekend multiplier)', () => {
    const r = priceOrder({ pickup_city: 'תל אביב', dropoff_city: 'רמת גן', service: 'standard', size: 'medium', when_hour: 20, when_date: '2026-07-03' });
    // 50 + 15 + 30 = 95 (Friday is regular day, no ×1.5)
    assert.strictEqual(r.price, 95);
  });
});

describe('Pricing: Review guards', () => {
  test('Flash Zone 3 → review (flash_unavailable_z3)', () => {
    const r = std('תל אביב', 'ראשון לציון', { service: 'flash' });
    assert.strictEqual(r.review, true);
    assert.ok(r.reasons.includes('flash_unavailable_z3'));
  });

  test('Out-of-zone city → review (out_of_zone)', () => {
    const r = std('תל אביב', 'חיפה');
    assert.strictEqual(r.review, true);
    assert.ok(r.reasons.includes('out_of_zone'));
  });

  test('Both cities unknown → review', () => {
    const r = std('ברלין', 'פריז');
    assert.strictEqual(r.review, true);
  });

  test('Valid Zone 1 order → no review', () => {
    const r = std('תל אביב', 'רמת גן');
    assert.strictEqual(r.review, false);
    assert.deepStrictEqual(r.reasons, []);
  });
});

describe('Pricing: Edge cases', () => {
  test('Default service is standard', () => {
    const r = priceOrder({ pickup_city: 'תל אביב', dropoff_city: 'רמת גן' });
    assert.strictEqual(r.service, 'standard');
    assert.strictEqual(r.price, 50);
  });

  test('Default size is small', () => {
    const r = priceOrder({ pickup_city: 'תל אביב', dropoff_city: 'רמת גן' });
    assert.strictEqual(r.size, 'small');
  });

  test('TLV variants all Zone 1 (תל אביב / תל אביב-יפו / תל אביב יפו)', () => {
    for (const city of ['תל אביב', 'תל אביב-יפו', 'תל אביב יפו']) {
      assert.strictEqual(zoneOf(city), 1, `${city} should be Zone 1`);
    }
  });

  test('קריית אונו and קרית אונו both Zone 2 (spelling variants)', () => {
    assert.strictEqual(zoneOf('קריית אונו'), 2);
    assert.strictEqual(zoneOf('קרית אונו'), 2);
  });
});
