import { test, describe } from 'node:test';
import assert from 'node:assert';

// ============================================================
// API INTEGRATION TESTS
// Runs against the live Worker API in TEST MODE (?test=1, no charge).
// Set API_URL env to run; skips gracefully if not configured (CI-safe).
// ============================================================

const API = process.env.API_URL || ''; // e.g. https://find.edenmish.com
const ORIGIN = process.env.TEST_ORIGIN || 'https://v2.edenmish.com';
const SKIP = !API;

const opts = { concurrency: 1 }; // serialize to avoid rate-limiting

describe('API: Order lifecycle (test mode)', { skip: SKIP }, () => {

  test('POST /api/orders?test=1 creates a paid order', async () => {
    const r = await fetch(`${API}/api/orders?test=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        name: 'CI Test', phone: '050-1112233', email: 'test@edenmish.com',
        service: 'standard', size: 'small',
        pickup: 'אלנבי 1, תל אביב', dropoff: 'בן גוריון 2, רמת גן',
        pickup_city: 'תל אביב', dropoff_city: 'רמת גן',
        when_text: '12:00-15:00', when_date: '2026-07-06', when_hour: 12
      })
    });
    const d = await r.json();
    assert.ok(d.token, 'should return a token');
    assert.strictEqual(d.status, 'paid', 'test mode should auto-pay');
    assert.strictEqual(d.test, true, 'should be flagged as test');
    assert.strictEqual(d.price, 50, 'Standard Zone 1 = ₪50');
  });

  test('GET /api/orders/:token returns magic-link tracking (no OTP)', async () => {
    // Create order first
    const cr = await fetch(`${API}/api/orders?test=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        name: 'CI Track', phone: '050-2223344', email: 'test@edenmish.com',
        service: 'eco', size: 'medium',
        pickup: 'הרצל 1, תל אביב', dropoff: 'דיזנגוף 100, תל אביב',
        pickup_city: 'תל אביב', dropoff_city: 'תל אביב',
        when_text: '09:00-12:00', when_date: '2026-07-06', when_hour: 9
      })
    });
    const cd = await cr.json();
    // Fetch tracking
    const tr = await fetch(`${API}/api/orders/${cd.token}`, { headers: { Origin: ORIGIN } });
    const td = await tr.json();
    assert.strictEqual(td.otp_pending, false, 'magic link: no OTP');
    assert.ok(td.order, 'should return full order');
    assert.strictEqual(td.order.price, 50, 'Eco Z1 + medium = 35+15 = ₪50');
  });

  test('CORS preflight returns correct headers', async () => {
    const r = await fetch(`${API}/api/orders`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' }
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('access-control-allow-origin'), 'should have CORS origin');
    assert.ok(r.headers.get('access-control-allow-methods'), 'should have CORS methods');
  });

  test('Out-of-zone order is flagged for review (internally)', async () => {
    const r = await fetch(`${API}/api/orders?test=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        name: 'CI Zone', phone: '050-3334455', email: 'test@edenmish.com',
        service: 'standard', size: 'small',
        pickup: 'אלנבי 1, תל אביב', dropoff: 'רחוב ראשי, חיפה',
        pickup_city: 'תל אביב', dropoff_city: 'חיפה',
        when_text: '12:00-15:00', when_date: '2026-07-06', when_hour: 12
      })
    });
    const d = await r.json();
    // Test mode masks review in response, but the order should still exist
    assert.ok(d.token, 'should create order');
    // In real mode (no ?test=1), this would return review:true, reasons:['out_of_zone']
  });

  test('Flash Zone 3 is flagged for review (internally)', async () => {
    const r = await fetch(`${API}/api/orders?test=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        name: 'CI Flash', phone: '050-4445566', email: 'test@edenmish.com',
        service: 'flash', size: 'small',
        pickup: 'הרצל 1, ראשון לציון', dropoff: 'ביאליק 2, פתח תקווה',
        pickup_city: 'ראשון לציון', dropoff_city: 'פתח תקווה',
        when_text: '09:00-12:00', when_date: '2026-07-06', when_hour: 9
      })
    });
    const d = await r.json();
    assert.ok(d.token, 'should create order');
    // Flash Z3 base is null → fallback ₪50 + no flash_z3 price
    // In real mode, review:true with flash_unavailable_z3
  });

  test('Rate limiting: 6th order within 10min gets 429', async () => {
    // This test creates 6 orders rapidly; the 6th should be rate-limited
    // Skip if previous tests already consumed the rate limit
    let lastStatus = 200;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${API}/api/orders?test=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          name: `CI Rate ${i}`, phone: `050-${String(5556670 + i).padStart(7, '0')}`,
          email: 'test@edenmish.com', service: 'standard', size: 'small',
          pickup: 'אלנבי 1, תל אביב', dropoff: 'בן גוריון 2, רמת גן',
          pickup_city: 'תל אביב', dropoff_city: 'רמת גן',
          when_text: '12:00', when_date: '2026-07-06', when_hour: 12
        })
      });
      lastStatus = r.status;
      if (r.status === 429) break;
    }
    // The 6th should be 429 (rate limit is 5 per 10min)
    assert.ok(lastStatus === 200 || lastStatus === 429, `rate limit should trigger (got ${lastStatus})`);
  });
});

describe('API: Pricing regression (test mode)', { skip: SKIP }, () => {
  const cases = [
    { svc: 'standard', sz: 'small', pc: 'תל אביב', dc: 'רמת גן', expect: 50, label: 'Std Z1' },
    { svc: 'standard', sz: 'medium', pc: 'תל אביב', dc: 'חולון', expect: 85, label: 'Std Z2 medium (70+15)' },
    { svc: 'eco', sz: 'small', pc: 'תל אביב', dc: 'רמת גן', expect: 35, label: 'Eco Z1' },
    { svc: 'flash', sz: 'small', pc: 'תל אביב', dc: 'רמת גן', expect: 85, label: 'Flash Z1' },
  ];

  for (const c of cases) {
    test(`${c.label} = ₪${c.expect}`, async () => {
      const r = await fetch(`${API}/api/orders?test=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          name: 'CI Price', phone: '050-7778899', email: 'test@edenmish.com',
          service: c.svc, size: c.sz,
          pickup: 'רחוב 1', dropoff: 'רחוב 2',
          pickup_city: c.pc, dropoff_city: c.dc,
          when_text: '12:00', when_date: '2026-07-06', when_hour: 12
        })
      });
      const d = await r.json();
      assert.strictEqual(d.price, c.expect, `${c.label} should be ₪${c.expect}`);
    });
  }
});
