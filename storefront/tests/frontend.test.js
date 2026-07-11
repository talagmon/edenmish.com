import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PUB = join(process.cwd(), 'public');

function readPage(name) {
  const p = join(PUB, name);
  if (!existsSync(p)) throw new Error(`${name} not found`);
  return readFileSync(p, 'utf8');
}

function assertContains(html, needle, label) {
  assert.ok(html.includes(needle), `${label || needle} missing from page`);
}

describe('Frontend: Pages exist', () => {
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'success.html', 'error.html', 'terms.html', 'privacy.html', 'refund.html']) {
    test(`${page} exists`, () => {
      assert.ok(existsSync(join(PUB, page)), `${page} not found in public/`);
    });
  }
});

describe('Frontend: RTL + viewport', () => {
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'success.html', 'error.html']) {
    test(`${page} is RTL Hebrew with locked viewport`, () => {
      const h = readPage(page);
      assertContains(h, 'dir="rtl"', `${page} RTL`);
      assertContains(h, 'lang="he"', `${page} Hebrew`);
      assertContains(h, 'user-scalable=no', `${page} viewport locked`);
    });
  }
});

describe('Frontend: Stylesheet + fonts', () => {
  test('Compiled CSS exists', () => {
    assert.ok(existsSync(join(PUB, 'assets', 'styles.css')), 'assets/styles.css missing');
  });
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html']) {
    test(`${page} links stylesheet + Hanken Grotesk`, () => {
      const h = readPage(page);
      assertContains(h, '/assets/styles.css');
      assertContains(h, 'Hanken+Grotesk');
    });
  }
});

describe('Frontend: Booking form', () => {
  const html = readPage('booking.html');

  test('Has size selector (Small/Medium)', () => {
    assertContains(html, 'name="size"', 'size radio');
    assertContains(html, 'value="small"', 'small option');
    assertContains(html, 'value="medium"', 'medium option');
  });

  test('Has service selector (Eco/Standard/Flash)', () => {
    assertContains(html, 'name="service"', 'service radio');
    assertContains(html, 'value="standard"', 'standard option');
    assertContains(html, 'value="flash"', 'flash option');
    assertContains(html, 'value="eco"', 'eco option');
  });

  test('Has special instructions textarea', () => {
    assertContains(html, 'name="notes"', 'notes textarea');
    assertContains(html, 'הוראות מיוחדות', 'instructions heading');
  });

  test('Has terms checkbox with consent', () => {
    assertContains(html, 'id="agree-terms"', 'terms checkbox');
    assertContains(html, 'תקנון', 'terms link');
    assertContains(html, 'מדיניות פרטיות', 'privacy link');
    assertContains(html, 'WhatsApp', 'WhatsApp consent');
  });

  test('Has Maps key loader', () => {
    assertContains(html, '/maps-key', 'maps-key endpoint');
    assertContains(html, '__initAutocomplete', 'autocomplete callback');
  });

  test('Has area gate (Gush-Dan bounds)', () => {
    assertContains(html, 'inGushDanBounds', 'coordinate gate');
    assertContains(html, 'EDEN_ZONES', 'city zone list');
  });

  test('Has scheduling (business hours)', () => {
    assertContains(html, 'schedHours', 'business hours function');
    assertContains(html, 'genWindows', 'window generation');
  });

  test('Sends when_date + when_hour + notes in payload', () => {
    assertContains(html, 'when_date:', 'payload when_date');
    assertContains(html, 'when_hour:', 'payload when_hour');
    assertContains(html, 'notes:', 'payload notes');
  });

  test('Flash is present-moment only (immediate dispatch)', () => {
    assertContains(html, 'flashAvailableNow', 'flash working-hours gate');
    assertContains(html, 'asap:', 'payload asap flag');
  });

  test('Has coupon UI in price summary', () => {
    assertContains(html, 'id="coupon-toggle"', 'coupon toggle');
    assertContains(html, 'יש לך קוד קופון?', 'coupon toggle text');
    assertContains(html, 'id="coupon-input"', 'coupon input');
    assertContains(html, 'id="coupon-apply"', 'coupon apply button');
    assertContains(html, 'החל', 'coupon apply text');
    assertContains(html, 'id="coupon-active"', 'coupon active panel');
    assertContains(html, 'id="coupon-original"', 'coupon original price');
    assertContains(html, 'id="coupon-discount"', 'coupon discount amount');
    assertContains(html, 'id="coupon-final"', 'coupon final price');
    assertContains(html, 'id="coupon-remove"', 'coupon remove button');
    assertContains(html, 'הסרת קופון', 'coupon remove text');
    assertContains(html, 'id="coupon-error"', 'coupon error');
    assertContains(html, 'id="coupon-cleared"', 'coupon cleared notice');
  });

  test('Calls coupon validation API', () => {
    assertContains(html, '/api/coupons/validate', 'coupon validate endpoint');
    assertContains(html, 'validateCoupon', 'validateCoupon function');
  });

  test('Sends coupon_code in order payload conditionally', () => {
    assertContains(html, 'couponState.code', 'coupon state check');
    assertContains(html, 'payload.coupon_code', 'coupon payload field');
  });

  test('Handles invalid_coupon server response', () => {
    assertContains(html, '"invalid_coupon"', 'invalid_coupon error string');
    assertContains(html, 'showCouponError', 'showCouponError handler');
  });
});

describe('Frontend: Tracking page', () => {
  const html = readPage('track.html');

  test('Has live map container', () => {
    assertContains(html, 'id="map"', 'map div');
  });

  test('Has magic-link (no forced OTP for active orders)', () => {
    assertContains(html, 'otp_pending', 'OTP check');
  });

  test('Has PoD display (delivered photo)', () => {
    assertContains(html, 'proof.photo_url', 'photo display');
  });

  test('Uses Asia/Jerusalem timezone', () => {
    assertContains(html, 'Asia/Jerusalem', 'Israel timezone');
  });
});

describe('Frontend: Ops security hardening', () => {
  test('dashboard uses cookie credentials instead of localStorage bearer tokens', () => {
    const html = readPage('dash.html');
    assert.ok(!html.includes("localStorage.getItem('ops_sess')"));
    assert.ok(!html.includes('X-Ops'));
    assertContains(html, 'credentials="include"');
  });

  test('static responses define a restrictive Content Security Policy', () => {
    const headers = readFileSync(join(PUB, '_headers'), 'utf8');
    assertContains(headers, 'Content-Security-Policy:');
    assertContains(headers, "object-src 'none'");
    assertContains(headers, "base-uri 'self'");
  });
});

describe('Frontend: Legal pages', () => {
  test('Terms page has עוסק פטור + number', () => {
    const h = readPage('terms.html');
    assertContains(h, 'עוסק פטור');
    assertContains(h, '211568928', 'exempt dealer number');
  });

  test('Privacy page exists with sections', () => {
    const h = readPage('privacy.html');
    assertContains(h, 'מדיניות פרטיות');
    assertContains(h, 'עוסק פטור');
  });

  test('Refund page has cancellation tiers', () => {
    const h = readPage('refund.html');
    assertContains(h, 'מדיניות ביטול');
    assertContains(h, '50%', '50% tier');
    assertContains(h, '14 ימי עסקים', 'refund window');
  });
});

describe('Frontend: Mobile nav', () => {
  test('mobile-nav.js exists and has zoom lock', () => {
    const js = readFileSync(join(PUB, 'assets', 'mobile-nav.js'), 'utf8');
    assertContains(js, 'gesturestart', 'iOS zoom lock');
    assertContains(js, 'touches.length > 1', 'pinch zoom lock');
    assertContains(js, 'burger', 'hamburger builder');
    assertContains(js, 'עוסק פטור', 'legal footer line');
  });

  test('Pages include mobile-nav.js', () => {
    for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'error.html', 'success.html']) {
      assertContains(readPage(page), 'mobile-nav.js', `${page} mobile-nav script`);
    }
  });
});
