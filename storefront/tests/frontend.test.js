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
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'success.html', 'error.html', 'terms.html', 'privacy.html', 'refund.html', 'accessibility.html', 'cancel.html']) {
    test(`${page} exists`, () => {
      assert.ok(existsSync(join(PUB, page)), `${page} not found in public/`);
    });
  }
});

describe('Frontend: RTL + accessible viewport', () => {
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'success.html', 'error.html', 'accessibility.html', 'cancel.html']) {
    test(`${page} is RTL Hebrew and allows browser zoom`, () => {
      const h = readPage(page);
      assertContains(h, 'dir="rtl"', `${page} RTL`);
      assertContains(h, 'lang="he"', `${page} Hebrew`);
      assert.ok(!h.includes('user-scalable=no'), `${page} must not disable browser zoom`);
    });
  }
});

describe('Frontend: Stylesheet + fonts', () => {
  test('Compiled CSS exists', () => {
    assert.ok(existsSync(join(PUB, 'assets', 'styles.css')), 'assets/styles.css missing');
  });
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'accessibility.html']) {
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

  test('Has terms acceptance separated from operational notifications', () => {
    assertContains(html, 'id="agree-terms"', 'terms checkbox');
    assertContains(html, 'תקנון', 'terms link');
    assertContains(html, 'מדיניות פרטיות', 'privacy link');
    assertContains(html, 'אין חובה חוקית למסור', 'privacy collection notice');
    assertContains(html, 'לא יישלח דיוור שיווקי מכוח אישור זה', 'no bundled marketing consent');
    assert.ok(!html.includes('הנני מסכים/ה לקבל עדכונים'), 'transaction acceptance must not be bundled with communications consent');
    assertContains(html, 'EdenMish אינה שומרת פרטי כרטיס אשראי', 'accurate hosted-payment disclosure');
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
    assertContains(html, 'הזמנה לאותו היום עד 09:00 כולל', 'same-day Eco cutoff');
  });

  test('Sends when_date + when_hour + notes in payload', () => {
    assertContains(html, 'when_date:', 'payload when_date');
    assertContains(html, 'when_hour:', 'payload when_hour');
    assertContains(html, 'notes:', 'payload notes');
    assertContains(html, 'service === "eco" ? "חסכוני"', 'Hebrew service label');
    assertContains(html, '"מיידי · עכשיו"', 'Hebrew immediate schedule label');
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

  test('Displays service names in Hebrew', () => {
    assertContains(html, 'eco: "חסכוני"');
    assertContains(html, 'standard: "רגיל"');
    assertContains(html, 'flash: "מהיר"');
  });
});

describe('Frontend: Security and accessibility hardening', () => {
  test('ops dashboard uses cookie credentials instead of localStorage bearer tokens', () => {
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

  test('delivery rating is keyboard-operable', () => {
    const html = readPage('delivered.html');
    assertContains(html, '<button type="button" class="material-symbols-outlined star');
    assertContains(html, 'aria-label="דירוג ');
  });

  test('FAQ controls expose keyboard and expanded state', () => {
    const html = readPage('about.html');
    assertContains(html, 'role="button"');
    assertContains(html, 'tabindex="0"');
    assertContains(html, 'aria-expanded=');
    assertContains(html, 'עד מתי אפשר להזמין משלוח חסכוני לאותו היום?', 'Eco FAQ question');
    assertContains(html, 'עד 09:00 כולל', 'Eco FAQ same-day cutoff');
    assertContains(html, 'האיסוף מתבצע עד 13:00', 'Eco FAQ pickup cutoff');
    assertContains(html, 'המסירה עד סוף אותו היום', 'Eco FAQ delivery SLA');
    assert.ok(!html.includes('(Eco)'), 'customer FAQ must not expose English service labels');
  });

  test('staging and preview pages use isolated Worker origins', () => {
    const routing = readFileSync(join(PUB, 'assets', 'api-origin.js'), 'utf8');
    assertContains(routing, "host === 'staging.edenmish.com'");
    assertContains(routing, "host.endsWith('.pages.dev')");
    assertContains(routing, 'https://find-staging.edenmish.com');
    assertContains(routing, 'https://ops-staging.edenmish.com');
    for (const page of ['booking.html', 'track.html', 'delivered.html', 'dash.html']) {
      assertContains(readPage(page), '/assets/api-origin.js', `${page} shared API routing`);
    }
  });

  test('ops dashboard renders a retryable connection error instead of hanging', () => {
    const html = readPage('dash.html');
    assertContains(html, 'function connectionErrorView()');
    assertContains(html, 'לא ניתן להתחבר למרכז הבקרה');
    assertContains(html, 'onclick="refresh()"');
    assertContains(html, 'catch(e){return connectionErrorView();}');
  });

  test('ops dashboard requests GPS only from an explicit start/stop control', () => {
    const html = readPage('dash.html');
    assertContains(html, 'התחלת שיתוף מיקום');
    assertContains(html, 'הפסקת שיתוף מיקום');
    assertContains(html, 'aria-live="polite"');
    assertContains(html, 'function toggleGps(id)');
    assert.ok(!html.includes('if(isLive && watchId===null) startWatch(o.id)'), 'detail rendering must not request location');
    assert.ok(!html.includes('if(st==="to_pickup"||st==="to_dropoff")startWatch(id)'), 'status changes must not request location');
  });
});

describe('Frontend: Legal pages', () => {
  const businessAddress = 'קריניצי 111, רמת גן, ישראל';

  test('Terms page has עוסק פטור + number', () => {
    const h = readPage('terms.html');
    assertContains(h, 'עוסק פטור');
    assertContains(h, '211568928', 'exempt dealer number');
    assertContains(h, 'מתקבלת עד 09:00 כולל', 'same-day Eco policy');
    assertContains(h, 'האיסוף יתבצע עד 13:00', 'Eco pickup cutoff');
    assertContains(h, businessAddress, 'business address');
  });

  test('Privacy page exists with sections', () => {
    const h = readPage('privacy.html');
    assertContains(h, 'מדיניות פרטיות');
    assertContains(h, 'עוסק פטור');
    assertContains(h, businessAddress, 'business address');
    assertContains(h, 'אין חובה חוקית למסור מידע אישי', 'section 11 collection disclosure');
    assertContains(h, 'Cloudflare', 'actual processor disclosure');
    assertContains(h, 'סעיפים 13–14', 'access and correction rights');
    assert.ok(!h.includes('לקבלו בפורמט נייד'), 'must not promise unsupported portability rights');
  });

  test('Refund page states statutory cancellation rights', () => {
    const h = readPage('refund.html');
    assertContains(h, 'מדיניות ביטול');
    assertContains(h, '5% ממחיר העסקה או 100 ₪', 'statutory fee cap');
    assertContains(h, 'בתוך 14 ימים', 'statutory refund window');
    assertContains(h, 'שני ימים שאינם ימי מנוחה', 'service cancellation timing');
    assertContains(h, 'href="/cancel.html"', 'online cancellation method');
    assertContains(h, businessAddress, 'business address');
  });

  test('Customer pages use the standardized business address', () => {
    for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'terms.html', 'privacy.html', 'refund.html', 'accessibility.html', 'cancel.html']) {
      const h = readPage(page);
      assertContains(h, businessAddress, `${page} business address`);
      assert.ok(!h.includes('קריניצי 111 ד׳'), `${page} must not use the old address variant`);
    }
  });

  test('Online cancellation form is prominent and privacy-minimizing', () => {
    const h = readPage('cancel.html');
    assertContains(readPage('index.html'), 'href="/cancel.html"', 'homepage cancellation link');
    assertContains(h, 'id="cancel-form"', 'online cancellation form');
    assertContains(h, '/api/cancellations', 'durable cancellation endpoint');
    assertContains(h, 'רק ארבע הספרות האחרונות', 'D1 identity minimization notice');
    assertContains(h, 'מספר אסמכתא', 'submission reference');
  });

  test('Accessibility declaration is transparent and contactable', () => {
    const h = readPage('accessibility.html');
    assertContains(h, 'הצהרת נגישות');
    assertContains(h, 'לא עבר בשלב זה אישור רשמי', 'no unsupported certification claim');
    assertContains(h, 'קבלת שירות בדרך חלופית', 'accessible alternative');
    assertContains(h, 'איש קשר לענייני נגישות: עדן אריאלי', 'accessibility contact');
    assertContains(h, businessAddress, 'business address');
  });

  test('Terms and customer footers link to the accessibility declaration', () => {
    assertContains(readPage('terms.html'), 'href="/accessibility.html">הצהרת הנגישות</a>', 'Terms accessibility clause');
    for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'terms.html', 'privacy.html', 'refund.html', 'error.html', 'delivered.html']) {
      assertContains(readPage(page), 'href="/accessibility.html"', `${page} accessibility link`);
    }
  });
});

describe('Frontend: Mobile nav', () => {
  test('mobile-nav.js exists and does not block zoom gestures', () => {
    const js = readFileSync(join(PUB, 'assets', 'mobile-nav.js'), 'utf8');
    assert.ok(!js.includes('gesturestart'), 'must not block iOS zoom');
    assert.ok(!js.includes('touches.length > 1'), 'must not block pinch zoom');
    assertContains(js, 'burger', 'hamburger builder');
    assertContains(js, 'עוסק פטור', 'legal footer line');
  });

  test('Pages include mobile-nav.js', () => {
    for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'error.html', 'success.html']) {
      assertContains(readPage(page), 'mobile-nav.js', `${page} mobile-nav script`);
    }
  });
});
