import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { onRequestGet as analyticsConfigResponse } from '../functions/analytics-config.js';

const PUB = join(process.cwd(), 'public');

function readPage(name) {
  const p = join(PUB, name);
  if (!existsSync(p)) throw new Error(`${name} not found`);
  return readFileSync(p, 'utf8');
}

function assertContains(html, needle, label) {
  assert.ok(html.includes(needle), `${label || needle} missing from page`);
}

function paymentFailureRetryHarness({ search = '', referrer = '' } = {}) {
  const html = readPage('payment-failed.html');
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
  assert.ok(source, 'payment failure retry script missing');
  const retry = {
    href: 'https://edenmish.com/',
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
  };
  runInNewContext(source, {
    window: {
      location: {
        href: `https://edenmish.com/payment-failed.html${search}`,
        search,
        assign() {},
      },
      history: { length: 1, back() {} },
      setTimeout() {},
    },
    document: { referrer, getElementById: () => retry },
    URL,
    URLSearchParams,
    Set,
  });
  return retry;
}

function themePaymentExit(pathname, search = '') {
  const theme = readFileSync(join(process.cwd(), '..', 'theme', 'layout', 'theme.liquid'), 'utf8');
  const source = theme.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/)?.[1];
  assert.ok(source, 'payment-host redirect script missing');
  let destination = null;
  runInNewContext(source, {
    window: {
      location: {
        pathname,
        search,
        replace(value) { destination = value; },
      },
    },
  });
  return destination;
}

async function paymentConfirmationHarness({ credential = '', status = 202, body = { status: 'pending' } } = {}) {
  const html = readPage('thank-you.html');
  const marker = "<script>\n  (() => {\n    const STORAGE_KEY = 'edenmish_payment_confirmation_v1';";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, 'payment confirmation script missing');
  const sourceStart = start + '<script>'.length;
  const sourceEnd = html.indexOf('</script>', sourceStart);
  const source = html.slice(sourceStart, sourceEnd);
  const listeners = {};
  const timers = [];
  const fetchCalls = [];
  const session = new Map();
  if (credential) session.set('edenmish_payment_confirmation_v1', credential);
  const nodes = Object.fromEntries([
    'payment-status',
    'thank-you-title',
    'payment-lead',
    'payment-next',
  ].map((id) => [id, {
    textContent: '',
    paid: false,
    classList: { toggle(name, enabled) { if (name === 'is-paid') nodes[id].paid = enabled; } },
  }]));
  const sessionStorage = {
    getItem(key) { return session.get(key) || null; },
    removeItem(key) { session.delete(key); },
  };
  const document = {
    title: 'EdenMish | בדיקת מצב התשלום',
    getElementById(id) { return nodes[id]; },
  };
  const window = {
    EDEN_API: { find: 'https://find.edenmish.com' },
    addEventListener(type, handler) { listeners[type] = handler; },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  };
  runInNewContext(source, {
    window,
    document,
    sessionStorage,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return { status, json: async () => body };
    },
    JSON,
  });
  listeners.DOMContentLoaded();
  await new Promise(resolve => setImmediate(resolve));
  return { document, fetchCalls, nodes, session, timers };
}

async function analyticsHarness({
  consent = {
    googleAnalytics: 'denied',
    metaPixel: 'denied',
  },
  config = {
    gtmContainerId: 'GTM-TEST123',
    providers: { googleAnalytics: true, metaPixel: false },
    paidConversionEnabled: true,
  },
  pathname = '/booking',
  search = '',
  hash = '',
  referrer = '',
  conversionCredential = '',
  fetchHandler = null,
  immediateTimers = true,
} = {}) {
  const source = readFileSync(join(PUB, 'assets', 'analytics.js'), 'utf8');
  const appended = [];
  const bodyNodes = [];
  const listeners = {};
  const storage = new Map([
    ['edenmish_analytics_consent_v2', JSON.stringify(consent)],
  ]);
  const session = new Map();
  if (conversionCredential) {
    session.set('edenmish_paid_conversion_v1', conversionCredential);
  }
  const timers = [];
  const fetchCalls = [];
  let reloads = 0;
  const storageApi = (values) => ({
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  });
  const window = {
    EDEN_API: { find: 'https://find.edenmish.com' },
    localStorage: storageApi(storage),
    sessionStorage: storageApi(session),
    location: {
      pathname,
      search,
      hash,
      origin: 'https://edenmish.com',
      href: `https://edenmish.com${pathname}${search}${hash}`,
      reload() { reloads += 1; },
    },
    crypto: {
      getRandomValues(bytes) {
        bytes.forEach((_, index) => { bytes[index] = index + 1; });
        return bytes;
      },
    },
    setTimeout(callback, delay) {
      if (immediateTimers) callback();
      else timers.push({ callback, delay });
    },
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const makeNode = (tag) => ({
    tagName: tag.toUpperCase(),
    async: false,
    src: '',
    dataset: {},
    style: {},
    hidden: false,
    textContent: '',
    setAttribute() {},
    addEventListener() {},
    focus() {},
    remove() {
      const bodyIndex = bodyNodes.indexOf(this);
      if (bodyIndex >= 0) bodyNodes.splice(bodyIndex, 1);
      const headIndex = appended.indexOf(this);
      if (headIndex >= 0) appended.splice(headIndex, 1);
    },
  });
  const document = {
    referrer,
    activeElement: null,
    cookie: '',
    head: { appendChild(node) { appended.push(node); return node; } },
    body: { appendChild(node) { bodyNodes.push(node); return node; } },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll(selector) {
      if (selector === '[data-analytics-settings]') {
        return bodyNodes.filter(node => node.dataset.analyticsSettings);
      }
      if (selector === '[data-eden-analytics-script]') {
        return appended.filter(node => node.dataset.edenAnalyticsScript);
      }
      return [];
    },
    getElementById(id) { return bodyNodes.find(node => node.id === id) || null; },
    createElement: makeNode,
  };
  const fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    if (input === '/analytics-config') {
      return { ok: true, status: 200, json: async () => config };
    }
    if (fetchHandler) return fetchHandler(input, init);
    return { ok: true, status: 204, json: async () => ({}) };
  };
  runInNewContext(source, {
    window,
    document,
    fetch,
    URL,
    Set,
    Uint8Array,
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    window,
    appended,
    bodyNodes,
    listeners,
    storage,
    session,
    timers,
    fetchCalls,
    reloads: () => reloads,
  };
}

function trackingOtpHarness(response = { verified: true }) {
  const html = readPage('track.html');
  const source = html.split('// ---- OTP ----')[1].split('// ---- init ----')[0];
  let focused = -1;
  let fetchCalls = 0;
  let loadCalls = 0;
  const makeElement = (index = -1) => ({
    value: '', textContent: '', className: '', disabled: false,
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    focus() { focused = index; },
  });
  const inputs = Array.from({ length: 6 }, (_, i) => makeElement(i));
  const elements = {
    'otp-submit': makeElement(),
    'otp-resend': makeElement(),
    'otp-msg': makeElement(),
  };
  elements['otp-submit'].textContent = 'המשיכו למעקב';
  elements['otp-resend'].textContent = 'שלח קוד שוב';
  const context = {
    document: {
      querySelectorAll: () => inputs,
      querySelector: () => ({ classList: { add() {}, remove() {} } }),
    },
    $: id => elements[id],
    API: 'https://find.example',
    token: 'tracking-token',
    encodeURIComponent,
    setTimeout: fn => fn(),
    fetch: async () => { fetchCalls += 1; return { json: async () => response }; },
    loadOrder: () => { loadCalls += 1; },
    console,
  };
  runInNewContext(source, context);
  return {
    inputs,
    elements,
    dispatch: async (element, type, event = {}) => element.listeners[type] && element.listeners[type](event),
    focused: () => focused,
    fetchCalls: () => fetchCalls,
    loadCalls: () => loadCalls,
  };
}

function trackingRefreshPolicy() {
  const html = readPage('track.html');
  const source = html.split('// ---- Tracking refresh policy ----')[1].split('async function loadOrder()')[0];
  const context = {};
  runInNewContext(`${source}\nglobalThis.__policy = { isLiveTrackStatus, isTerminalTrackStatus, pollDelayForStatus, isFreshGps };`, context);
  return context.__policy;
}

function trackingEtaHelpers() {
  const html = readPage('track.html');
  const source = html.split('// ---- ETA helpers ----')[1].split('// ---- Live Google Map')[0];
  const context = {};
  runInNewContext(`${source}\nglobalThis.__eta = { routeDestination, etaCopy, formatEtaDuration, routeRefreshDue };`, context);
  return context.__eta;
}

function opsQueueHelpers() {
  const html = readPage('dash.html');
  const source = html.split('// ---- Ops queue helpers ----')[1].split('async function refresh()')[0];
  const activeMatch = html.match(/var ACTIVE = (\[[^;]+\]);/);
  assert.ok(activeMatch, 'canonical ops ACTIVE statuses missing');
  const context = { ACTIVE: JSON.parse(activeMatch[1]), deliveryDeadline: o => o.deadline || null };
  runInNewContext(`${source}\nglobalThis.__ops = { israelDateKey, isActiveOrder, dailyOpsSummary, scheduleSortKey, compareQueueOrders };`, context);
  return context.__ops;
}

describe('Frontend: Pages exist', () => {
  for (const page of ['index.html', 'booking.html', 'track.html', 'about.html', 'blog/edenmish-information-security.html', 'business.html', 'business-account.html', 'success.html', 'thank-you.html', 'payment-failed.html', '404.html', 'error.html', 'terms.html', 'privacy.html', 'refund.html', 'accessibility.html', 'cancel.html']) {
    test(`${page} exists`, () => {
      assert.ok(existsSync(join(PUB, page)), `${page} not found in public/`);
    });
  }
});

describe('Frontend: Shopify post-payment exit', () => {
  test('ships responsive EdenMish payment branding artwork', () => {
    for (const asset of [
      'edenmish-payment-background-desktop.webp',
      'edenmish-payment-background-mobile.webp',
    ]) {
      const path = join(PUB, 'assets', asset);
      assert.ok(existsSync(path), `${asset} not found`);
      assert.ok(readFileSync(path).byteLength > 20_000, `${asset} is unexpectedly small`);
    }
  });

  test('publishes a branded payment result page that defaults to unverified', () => {
    const html = readPage('thank-you.html');
    assertContains(html, 'בודקים את מצב התשלום', 'fail-closed initial status');
    assertContains(html, 'התשלום עדיין לא אושר', 'unverified initial heading');
    assertContains(html, 'התשלום התקבל בהצלחה', 'payment confirmation');
    assertContains(html, 'תודה שבחרתם ב-EdenMish', 'thank-you message');
    assertContains(html, "/api/payment-confirmation", 'authoritative payment confirmation endpoint');
    assertContains(html, "result.status === 'paid'", 'paid-only success gate');
    assertContains(html, 'src="./assets/edenmish-thank-you-bike.webp"', 'local- and web-safe thank-you artwork URL');
    assertContains(html, 'href="https://edenmish.com/"', 'main-site CTA');
    assertContains(html, 'direction: ltr;', 'desktop image-left composition');
    assertContains(html, '.message { min-height: 610px; direction: rtl; }', 'RTL message direction');
    assertContains(html, 'width: min(calc(100% - 2rem), 1120px);', 'mobile-safe page width');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-thank-you-bike.webp')), 'thank-you artwork not found');
    assert.ok(!html.includes('pay.edenmish.com'), 'thank-you page must not link back to the payment storefront');
  });

  test('shows success only after the Worker confirms the signed payment capability', async () => {
    const pending = await paymentConfirmationHarness({ credential: 'pending-token' });
    assert.equal(pending.nodes['payment-status'].paid, false);
    assert.equal(pending.document.title, 'EdenMish | בדיקת מצב התשלום');
    assert.equal(pending.timers.length, 1, 'pending webhook reconciliation should be retried');
    for (let attempt = 1; attempt < 10; attempt += 1) {
      const timer = pending.timers.shift();
      assert.ok(timer, `payment confirmation retry ${attempt} missing`);
      timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(pending.nodes['payment-status'].textContent, 'לא התקבל אישור תשלום');
    assert.equal(pending.nodes['thank-you-title'].textContent, 'התשלום עדיין לא הושלם');
    assert.equal(pending.nodes['payment-status'].paid, false);

    const paid = await paymentConfirmationHarness({
      credential: 'paid-token',
      status: 200,
      body: { status: 'paid' },
    });
    assert.equal(paid.nodes['payment-status'].textContent, 'התשלום התקבל בהצלחה');
    assert.equal(paid.nodes['payment-status'].paid, true);
    assert.equal(paid.document.title, 'EdenMish | תודה שבחרתם בנו');
    assert.equal(paid.session.has('edenmish_payment_confirmation_v1'), false);
  });

  test('does not claim success when the browser has no payment capability', async () => {
    const result = await paymentConfirmationHarness();
    assert.equal(result.fetchCalls.length, 0);
    assert.equal(result.nodes['payment-status'].textContent, 'לא ניתן לאמת כאן את התשלום');
    assert.equal(result.nodes['thank-you-title'].textContent, 'מחכים לאישור מ-Shopify');
    assert.equal(result.nodes['payment-status'].paid, false);
  });

  test('publishes a distinct failure page with a guarded retry destination', () => {
    const html = readPage('payment-failed.html');
    assertContains(html, 'התשלום לא הושלם', 'payment failure message');
    assertContains(html, 'לא בוצע חיוב מאושר', 'no confirmed charge message');
    assertContains(html, 'src="./assets/edenmish-payment-retry-bike.webp"', 'local failure artwork URL');
    assertContains(html, 'name="robots" content="noindex, nofollow"', 'transaction-page crawler exclusion');
    assertContains(html, "url.protocol !== 'https:'", 'HTTPS retry guard');
    assertContains(html, "url.port !== '443'", 'standard HTTPS port guard');
    assertContains(html, "allowedHosts.has(url.hostname)", 'retry host allowlist');
    assertContains(html, "params.get('retry_url')", 'explicit retry URL support');
    assertContains(html, 'safePaymentUrl(document.referrer)', 'checkout referrer retry support');
    assertContains(html, 'width: min(calc(100% - 2rem), 1120px);', 'mobile-safe failure page width');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-payment-retry-bike.webp')), 'failure artwork not found');
  });

  test('only exposes retry links that return to an EdenMish Shopify checkout host', () => {
    const checkout = 'https://pay.edenmish.com/checkouts/cn/example?key=test-value';
    const explicit = paymentFailureRetryHarness({ search: `?retry_url=${encodeURIComponent(checkout)}` });
    assert.equal(explicit.href, checkout);

    const fromCheckout = paymentFailureRetryHarness({ referrer: 'https://r013gt-fc.myshopify.com/123/invoices/example' });
    assert.equal(fromCheckout.href, 'https://r013gt-fc.myshopify.com/123/invoices/example');

    const malicious = paymentFailureRetryHarness({ search: `?retry_url=${encodeURIComponent('https://attacker.example/pay')}` });
    assert.equal(malicious.href, 'https://edenmish.com/');
    assert.equal(typeof malicious.listeners.click, 'function', 'unsafe retry URL must fall back to browser history');

    const paymentRoot = paymentFailureRetryHarness({ referrer: 'https://pay.edenmish.com/' });
    assert.equal(paymentRoot.href, 'https://edenmish.com/', 'payment root must not be offered as a retry destination');

    const nonstandardPort = paymentFailureRetryHarness({
      search: `?retry_url=${encodeURIComponent('https://pay.edenmish.com:8443/checkouts/example')}`,
    });
    assert.equal(nonstandardPort.href, 'https://edenmish.com/', 'nonstandard payment ports must be rejected');
  });

  test('routes explicit failures separately from the fail-closed payment result', () => {
    const theme = readFileSync(join(process.cwd(), '..', 'theme', 'layout', 'theme.liquid'), 'utf8');
    assertContains(theme, "request.host == 'pay.edenmish.com'", 'payment-host guard');
    assertContains(theme, "'/payment-failed'", 'explicit failure route');
    assertContains(theme, "'https://edenmish.com/payment-failed.html' + window.location.search", 'failure redirect');
    assertContains(theme, ": 'https://edenmish.com/thank-you.html'", 'success redirect');
    assertContains(theme, '<noscript><meta http-equiv="refresh" content="0;url=https://edenmish.com/"></noscript>', 'safe no-script fallback');
    assert.equal(themePaymentExit('/payment-failed', '?retry_url=example'), 'https://edenmish.com/payment-failed.html?retry_url=example');
    assert.equal(themePaymentExit('/pages/payment-failed'), 'https://edenmish.com/payment-failed.html');
    assert.equal(themePaymentExit('/'), 'https://edenmish.com/thank-you.html');
  });
});

describe('Frontend: Branded static error recovery', () => {
  test('publishes a noindex 404 page with the shared recovery artwork', () => {
    const html = readPage('404.html');
    assertContains(html, 'שגיאה 404', '404 status');
    assertContains(html, 'העמוד לא נמצא', '404 heading');
    assertContains(html, 'src="./assets/edenmish-payment-retry-bike.webp"', 'shared recovery artwork');
    assertContains(html, 'name="robots" content="noindex, nofollow"', '404 crawler exclusion');
    assertContains(html, 'id="back-cta"', 'back recovery action');
    assertContains(html, 'direction: ltr;', 'desktop image-left composition');
    assertContains(html, '.message { direction: rtl; }', 'right-side RTL message');
    assertContains(html, 'width: min(calc(100% - 2rem), 1120px);', 'mobile-safe 404 page width');
  });
});

describe('Frontend: Tracking terminal states', () => {
  test('does not offer payment again for a cancelled order', () => {
    const html = readPage('track.html');
    assertContains(
      html,
      'o.payment_url && o.payment_status !== "paid" && !TERMINAL_TRACK_STATUSES.includes(o.status)',
      'terminal-status payment guard',
    );
    assertContains(html, 'cancelled:"ההזמנה בוטלה"', 'cancelled tracking message');
  });
});

describe('Frontend: SEO foundations', () => {
  test('Publishes crawler directives and a focused sitemap', () => {
    const robots = readPage('robots.txt');
    const sitemap = readPage('sitemap.xml');
    assertContains(robots, 'Sitemap: https://edenmish.com/sitemap.xml', 'sitemap directive');
    assertContains(robots, 'Disallow: /dash', 'ops dashboard exclusion');
    assertContains(sitemap, '<loc>https://edenmish.com/</loc>', 'homepage sitemap entry');
    assertContains(sitemap, '<loc>https://edenmish.com/booking.html</loc>', 'booking sitemap entry');
    assertContains(sitemap, '<loc>https://edenmish.com/business</loc>', 'business plans sitemap entry');
    assertContains(sitemap, '<loc>https://edenmish.com/blog/edenmish-information-security</loc>', 'security article sitemap entry');
    assert.ok(!sitemap.includes('/dash'), 'ops dashboard must not be listed in the sitemap');
    assert.ok(!sitemap.includes('/success'), 'transaction result pages must not be listed in the sitemap');
  });

  test('Business page preserves both original offers and adds three account plans', () => {
    const html = readPage('business.html');
    for (const offer of ['חבילת ניסיון', 'ארנק עסקי', 'Silver · כסף', 'Gold · זהב', 'Platinum · פלטינום']) {
      assertContains(html, offer, `${offer} offer`);
    }
    for (const proof of ['חיסכון כולל ₪25', 'חיסכון כולל ₪250', 'חיסכון מוערך ₪65', 'חיסכון מוערך ₪115', 'חיסכון מוערך ₪308']) {
      assertContains(html, proof, `${proof} breakdown`);
    }
    for (const art of ['business-trial.webp', 'business-wallet.webp', 'business-silver.webp', 'business-gold.webp', 'business-platinum.webp']) {
      assertContains(html, art, `${art} plan artwork`);
      assert.ok(existsSync(join(PUB, 'assets', art)), `${art} not found in public assets`);
    }
    assertContains(html, 'ללא דמי מנוי', 'business value pitch');
    assertContains(html, 'href="/business-account.html"', 'business account CTA');
    for (const plan of ['trial', 'wallet', 'silver', 'gold', 'platinum']) {
      assertContains(html, `href="/business-account.html?plan=${plan}"`, `${plan} account CTA`);
    }
    assert.ok(!html.includes('אני מעוניין/ת בחבילת הניסיון'), 'Trial must not use the assisted WhatsApp purchase flow');
    assert.ok(!html.includes('אני מעוניין/ת בארנק העסקי'), 'Business Wallet must not use the assisted WhatsApp purchase flow');
    const accountEntry = readPage('business-account.html');
    assertContains(accountEntry, 'allowedPlans', 'business account plan allowlist');
    assertContains(accountEntry, 'target.searchParams.set("plan",requestedPlan)', 'selected plan forwarding');
  });

  test('Homepage exposes valid LocalBusiness structured data', () => {
    const html = readPage('index.html');
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(match, 'LocalBusiness JSON-LD missing from homepage');
    const schema = JSON.parse(match[1]);
    assert.equal(schema['@context'], 'https://schema.org');
    assert.equal(schema['@type'], 'LocalBusiness');
    assert.equal(schema['@id'], 'https://edenmish.com/#business');
    assert.equal(schema.address.streetAddress, 'קריניצי 111');
    assert.equal(schema.address.addressLocality, 'רמת גן');
    assert.equal(schema.address.addressCountry, 'IL');
    assert.equal(schema.makesOffer.itemOffered['@type'], 'Service');
    assert.deepEqual(schema.areaServed.map(area => area.name), [
      'תל אביב-יפו', 'רמת גן', 'גבעתיים', 'בני ברק', 'הרצליה', 'רמת השרון',
      'חולון', 'בת ים', 'קריית אונו', 'גבעת שמואל', 'אזור', 'גני תקווה',
      'סביון', 'אור יהודה', 'ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה',
      'הוד השרון', 'רמלה', 'לוד'
    ]);
  });

  test('Homepage exposes every supported city in a fixed-height orbital map and directory', () => {
    const html = readPage('index.html');
    const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const cities = [
      'תל אביב-יפו', 'רמת גן', 'גבעתיים', 'בני ברק', 'הרצליה', 'רמת השרון',
      'חולון', 'בת ים', 'קריית אונו', 'גבעת שמואל', 'אזור', 'גני תקווה',
      'סביון', 'אור יהודה', 'ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה',
      'הוד השרון', 'רמלה', 'לוד'
    ];
    assertContains(html, 'aria-label="כל אזורי השירות של EdenMish"');
    assertContains(html, 'class="service-areas-shell', 'orbital service-area shell');
    assertContains(html, 'class="service-areas-stage"', 'fixed map and directory stage');
    assertContains(html, 'class="service-orbit-points"', 'interactive city orbit');
    assertContains(html, 'class="service-city-directory"', 'contained city directory');
    assertContains(html, 'id="service-city-search-input"', 'city search control');
    assertContains(html, 'src="/assets/service-areas.js"', 'service-area interaction script');
    assertContains(styles, '.service-areas-stage {\n    height: 510px;', 'fixed desktop service-area stage');
    assertContains(styles, '.service-areas-stage {\n      height: 440px;', 'fixed mobile service-area stage');
    assertContains(styles, '.service-city-directory {', 'city directory styles');
    assertContains(styles, 'overflow-y: auto;', 'city directory scroll containment');
    for (const city of cities) {
      assertContains(html, `data-city="${city}"`, `${city} interactive orbit point`);
      assertContains(html, `data-city-row="${city}"`, `${city} directory row`);
    }
  });

  test('Homepage ships the responsive glass presentation without changing customer destinations', () => {
    const html = readPage('index.html');
    const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    for (const hook of [
      'class="home-page ',
      'class="home-header ',
      'class="home-hero ',
      'class="home-hero-backdrop ',
      'class="home-live-card ',
      'class="home-process ',
      'home-service-areas',
      'home-benefits',
      'home-story',
      'home-final-cta',
    ]) {
      assertContains(html, hook, `${hook} presentation hook`);
    }
    for (const destination of ['href="/booking.html"', 'href="/track.html"', 'href="/about.html"', 'href="/cancel.html"']) {
      assertContains(html, destination, `${destination} customer destination`);
    }
    for (const deliveryState of ['התקבלה', 'אושר', 'לאיסוף', 'למסירה', 'נמסר']) {
      assertContains(html, deliveryState, `${deliveryState} live-delivery state`);
    }
    assertContains(html, '<strong>09:30</strong>', 'morning delivery example time');
    assert.ok(!html.includes('<strong>23:18</strong>'), 'late-night example time is retired');
    assertContains(html, 'class="home-footer-brand', 'brighter footer brand hook');
    assertContains(html, 'src="/assets/edenmish-home-hero-neon.webp"', 'motorcycle courier hero artwork with neon route trail');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-home-hero-neon.webp')), 'neon motorcycle hero artwork not found');
    assertContains(html, 'src="/assets/edenmish-city-orbit.webp"', 'service-area orbital map artwork');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-city-orbit.webp')), 'service-area orbital artwork not found');
    assert.ok(existsSync(join(PUB, 'assets', 'service-areas.js')), 'service-area interaction script not found');
    assertContains(styles, '.home-page {', 'homepage-only skin scope');
    assertContains(styles, '@media (max-width: 767px)', 'mobile presentation breakpoint');
    assertContains(styles, '.home-process-step:not(:last-child)::after', 'connected journey presentation');
    assert.deepEqual(
      [...html.matchAll(/class="home-benefit-number" aria-hidden="true">([123])<\/span>/g)].map((match) => match[1]),
      ['1', '2', '3'],
      'homepage benefits should use ordered numeric markers',
    );
    assert.equal(
      [...html.matchAll(/class="home-slogan-signature(?: home-slogan-signature--center)?"/g)].length,
      2,
      'homepage should use slogan signatures at two conversion moments',
    );
    for (const slogan of [
      'המשלוח בידיים בטוחות',
      'תזמינו בדקה. תשכחו מהדאגה.',
      'רואים הכול. סומכים על הכול.',
      'מהזמנה עד מסירה',
      'אתם בשליטה',
      'הזמנה ראשונה, 10% פחות. שירות שיגרום לכם לחזור.',
    ]) {
      assertContains(html, slogan, `${slogan} homepage slogan`);
    }
    assertContains(html, 'class="home-slogan-band"', 'process-to-service slogan transition');
    assertContains(html, 'class="home-live-slogan"', 'live-tracking slogan');
    assertContains(html, 'class="home-benefits-slogan"', 'benefits slogan');
    assertContains(styles, '.home-slogan-signature {', 'slogan signature styling');
    assertContains(styles, '.home-slogan-band {', 'process slogan styling');
    assertContains(styles, '.home-benefit-number {', 'numeric benefit marker styling');
    assertContains(styles, '.home-footer-brand {', 'brighter footer brand styling');
    assertContains(styles, 'color: #f8fafc;', 'white footer brand color');
    assertContains(styles, '@media (min-width: 768px) and (max-width: 1023px)', 'tablet navigation breakpoint');
    assertContains(styles, '.home-nav > nav {\n      gap: 18px;', 'tablet navigation spacing');
    assertContains(styles, 'backdrop-filter: blur(24px) saturate(150%);', 'layered glass navigation');
  });

  test('Customer journeys carry the slogan system and the About page ships the selected contact concept', () => {
    const about = readPage('about.html');
    const booking = readPage('booking.html');
    const tracking = readPage('track.html');
    const business = readPage('business.html');
    const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

    for (const [html, slogan, page] of [
      [about, 'שולחים בראש שקט', 'about'],
      [about, 'תנו לנו הזדמנות אחת. תראו את ההבדל.', 'about CTA'],
      [booking, 'הזמנת משלוח? זה כבר בדרך.', 'booking'],
      [tracking, 'רואים הכול. סומכים על הכול.', 'tracking'],
      [business, 'משלוח חכם. הגעה בטוחה.', 'business'],
    ]) {
      assertContains(html, slogan, `${page} slogan`);
    }

    for (const hook of [
      'class="about-founder-hero ',
      'class="about-story-video ',
      'class="about-contact-console ',
      'class="about-contact-panel"',
      'class="about-area-panel"',
      'class="about-faq ',
      'class="about-cta"',
      'class="about-team"',
      'class="eden-about-sunflower"',
      'src="/assets/eden-arieli-portrait.webp"',
      'src="/assets/edenmish-city-orbit.webp"',
      'src="/assets/edenmish-v0.mp4"',
    ]) {
      assertContains(about, hook, `${hook} About-page presentation hook`);
    }
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-city-orbit.webp')), 'About-page orbital map artwork not found');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-v0.mp4')), 'About-page brand film not found');
    assert.ok(existsSync(join(PUB, 'assets', 'eden-arieli-portrait.webp')), 'About-page founder portrait not found');
    for (const city of [
      'תל אביב-יפו', 'רמת גן', 'גבעתיים', 'בני ברק', 'הרצליה', 'רמת השרון',
      'חולון', 'בת ים', 'קריית אונו', 'גבעת שמואל', 'אזור', 'גני תקווה',
      'סביון', 'אור יהודה', 'ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה',
      'הוד השרון', 'רמלה', 'לוד'
    ]) {
      assertContains(about, city, `${city} About-page service area`);
    }
    assertContains(styles, '.brand-slogan {', 'shared slogan styling');
    assertContains(styles, '.about-contact-console {', 'selected contact-console styling');
    assertContains(styles, '.about-founder-portrait {', 'selected 4:5 founder portrait styling');
    assertContains(styles, '.about-faq-list {', 'editorial FAQ styling');
    assertContains(styles, '.about-team-shell {', 'team and story styling');
    assertContains(styles, '@media (max-width: 1023px)', 'responsive About-page contact breakpoint');
  });

  test('Public journey CTAs share the semi-transparent glass treatment', () => {
    const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const success = readPage('success.html');
    const blog = readPage('blog/edenmish-information-security.html');
    const notFound = readPage('404.html');
    const paymentFailed = readPage('payment-failed.html');
    const thankYou = readPage('thank-you.html');

    assertContains(styles, '.public-glass-cta {', 'shared public CTA styling');
    assertContains(styles, 'backdrop-filter: blur(18px) saturate(150%);', 'shared CTA backdrop blur');
    assertContains(success, 'class="public-glass-cta hidden', 'success tracking CTA');
    assertContains(success, 'public-glass-cta public-glass-cta--secondary', 'success secondary CTA');
    assertContains(blog, 'class="public-glass-cta inline-flex', 'blog conversion CTA');
    for (const [html, page] of [
      [notFound, '404'],
      [paymentFailed, 'payment failure'],
      [thankYou, 'thank-you'],
    ]) {
      assertContains(html, 'blur(18px) saturate(150%)', `${page} glass CTA blur`);
      assertContains(html, 'rgba(128', `${page} translucent CTA fill`);
    }
  });

  test('Publishes the EdenMish platform story with professional attribution and honest launch copy', () => {
    const homepage = readPage('index.html');
    const about = readPage('about.html');
    const articleUrl = 'https://talagmon.com/2026/07/16/building-edenmish-delivery-operations-system/';
    const securityArticleUrl = '/blog/edenmish-information-security';
    const technicalReviewUrl = 'https://talagmon.com/2026/07/17/edenmish-security-review-what-we-fixed/';
    const securityArticle = readPage('blog/edenmish-information-security.html');
    assertContains(homepage, 'id="behind-the-scenes"', 'homepage story section');
    assertContains(homepage, articleUrl, 'homepage article link');
    assertContains(homepage, securityArticleUrl, 'homepage security article link');
    assertContains(homepage, 'במאמר נוסף בעברית', 'article language disclosure');
    assertContains(homepage, 'איך אנחנו שומרים על המידע שלכם', 'homepage security article label');
    assertContains(homepage, 'טל אגמון משתף', 'homepage author credit');
    assertContains(about, articleUrl, 'about-page article link');
    assertContains(about, securityArticleUrl, 'about-page security article link');
    assertContains(about, 'איך אנחנו שומרים על המידע שלכם', 'about-page security article label');
    assertContains(about, 'טל אגמון כתב', 'about-page author credit');
    assertContains(securityArticle, '<link rel="canonical" href="https://edenmish.com/blog/edenmish-information-security"', 'security article canonical URL');
    assertContains(securityArticle, 'https://github.com/usestrix/strix', 'Strix project credit');
    assertContains(securityArticle, technicalReviewUrl, 'technical security review link');
    assertContains(securityArticle, '"@type": "BlogPosting"', 'security article structured data');
    assert.ok(!securityArticle.includes('—'), 'security article must not use em dashes');
    assert.ok(!homepage.includes('Sol'), 'homepage must not present the AI model as a public co-author');
    assert.ok(!about.includes('Sol'), 'about page must not present the AI model as a public co-author');
    assert.ok(!homepage.includes('הצטרפו למאות עסקים'), 'homepage must not claim hundreds of customers during launch');
    assertContains(homepage, '10% הנחה על המשלוח הראשון ללקוחות חדשים', 'specific launch-stage CTA');
  });
});

describe('Frontend: consent-aware analytics', () => {
  const analytics = readFileSync(join(PUB, 'assets', 'analytics.js'), 'utf8');
  const analyticsConfig = readFileSync(join(process.cwd(), 'functions', 'analytics-config.js'), 'utf8');
  const headers = readPage('_headers');
  const customerPages = [
    'index.html', 'about.html', 'accessibility.html', 'booking.html', 'cancel.html',
    'business.html', 'delivered.html', 'error.html', 'privacy.html', 'refund.html',
    'success.html', 'terms.html', 'thank-you.html', 'track.html'
  ];

  test('Loads the shared consent boundary on customer pages but not the ops dashboard', () => {
    for (const page of customerPages) {
      assertContains(readPage(page), '<script src="/assets/analytics.js" defer></script>', `${page} analytics boundary`);
    }
    assert.ok(!readPage('dash.html').includes('/assets/analytics.js'), 'ops dashboard must not load marketing analytics');
  });

  test('Fails closed and loads vendor scripts only after an explicit opt-in', () => {
    assertContains(analytics, 'edenmish_analytics_consent_v2', 'provider-specific consent storage');
    assertContains(analytics, 'fetch("/analytics-config"', 'first-party analytics configuration');
    assertContains(analytics, 'configuredProviders().some(providerGranted)', 'stored opt-in gate');
    assertContains(analytics, 'consent[provider] === "unknown"', 'unknown-consent dialog gate');
    assertContains(analytics, 'https://www.googletagmanager.com/gtm.js?id=', 'GTM loader');
    assert.ok(!analytics.includes('https://connect.facebook.net/en_US/fbevents.js'), 'vendors must be configured inside GTM');
    assertContains(analytics, 'updateGoogleConsent("default")', 'Google consent default');
    assertContains(analytics, 'analytics_storage: granted ? "granted" : "denied"', 'Google consent state');
    assertContains(analytics, 'event: "eden_consent_updated"', 'GTM consent update event');
    assertContains(analytics, 'רק חיוניות', 'Hebrew reject choice');
    assertContains(analytics, 'שמירת בחירה', 'Hebrew preference save choice');
  });

  test('Queues namespaced GTM events only after stored opt-in', async () => {
    const denied = await analyticsHarness();
    assert.equal(denied.appended.length, 0, 'GTM must remain unloaded after rejection');
    assert.ok(!denied.window.dataLayer.some(item => item?.event === 'gtm.js'), 'rejected visits must not bootstrap GTM');
    assert.ok(!denied.window.dataLayer.some(item => /^eden_(?:booking|payment|tracking|whatsapp|cancellation|paid)/.test(item?.event || '')), 'rejected visits must queue no business events');

    const granted = await analyticsHarness({
      consent: { googleAnalytics: 'granted', metaPixel: 'denied' },
    });
    assert.equal(granted.appended.length, 1, 'GTM must load exactly once after opt-in');
    assert.equal(granted.appended[0].src, 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST123');
    assert.equal(granted.appended[0].referrerPolicy, 'no-referrer');
    assert.ok(granted.window.dataLayer.some(item => item?.event === 'gtm.js'), 'GTM bootstrap event missing');
    assert.ok(granted.window.dataLayer.some(item => item?.event === 'eden_booking_started'), 'booking start event missing');

    assert.equal(granted.window.edenAnalytics.track('whatsapp_clicked', { source: '/booking', email: 'blocked@example.com' }), true);
    const contact = granted.window.dataLayer.at(-1);
    assert.equal(contact.event, 'eden_whatsapp_clicked');
    assert.equal(contact.eden_source, '/booking');
    assert.ok(!('eden_email' in contact), 'non-allowlisted fields must be discarded');
  });

  test('Fails closed on sensitive locations/referrers and supports immediate cross-tab withdrawal', async () => {
    const sensitive = await analyticsHarness({
      consent: { googleAnalytics: 'granted', metaPixel: 'denied' },
      pathname: '/track.html',
      search: '?t=TRACKING_SECRET',
      referrer: 'https://edenmish.com/business?challenge=SECRET',
    });
    assert.equal(sensitive.appended.length, 0, 'sensitive document must not load GTM');
    assert.equal(sensitive.window.edenAnalytics.track('tracking_opened', { source: '/track.html' }), false);
    assert.ok(!JSON.stringify(sensitive.window.dataLayer).includes('TRACKING_SECRET'));
    assert.ok(!JSON.stringify(sensitive.window.dataLayer).includes('SECRET'));

    const granted = await analyticsHarness({
      consent: { googleAnalytics: 'granted', metaPixel: 'denied' },
    });
    granted.storage.set('edenmish_analytics_consent_v2', JSON.stringify({
      googleAnalytics: 'denied',
      metaPixel: 'denied',
    }));
    granted.listeners.storage({ key: 'edenmish_analytics_consent_v2' });
    assert.equal(granted.window.edenAnalytics.track('booking_submitted', {}), false);
    assert.equal(granted.reloads(), 1, 'loaded vendor runtime must be terminated by same-URL reload');
  });

  test('Uses environment-provided public IDs and excludes personal/order identifiers', () => {
    assertContains(analyticsConfig, 'env.GTM_CONTAINER_ID', 'GTM Pages variable');
    assertContains(analyticsConfig, 'env.ANALYTICS_GOOGLE_ENABLED', 'explicit Google provider gate');
    assertContains(analyticsConfig, 'env.ANALYTICS_META_ENABLED', 'explicit Meta provider gate');
    assertContains(analyticsConfig, '/^GTM-[A-Z0-9]+$/', 'GTM identifier validation');
    assert.ok(!analyticsConfig.includes('GA4_MEASUREMENT_ID'), 'GA4 ID belongs in GTM');
    assert.ok(!analyticsConfig.includes('META_PIXEL_ID'), 'Meta ID belongs in GTM');
    for (const forbidden of ['order_id', 'tracking_token', 'email', 'phone', 'address']) {
      assert.ok(!analytics.includes(forbidden), `analytics boundary must not reference ${forbidden}`);
    }
  });

  test('Requires an explicit provider flag in addition to a valid GTM ID', async () => {
    const disabled = await analyticsConfigResponse({
      env: { GTM_CONTAINER_ID: 'GTM-TEST123' },
      request: new Request('https://edenmish.com/analytics-config'),
    });
    assert.deepEqual(await disabled.json(), {
      gtmContainerId: 'GTM-TEST123',
      providers: { googleAnalytics: false, metaPixel: false },
      paidConversionEnabled: false,
    });

    const googleOnly = await analyticsConfigResponse({
      env: {
        GTM_CONTAINER_ID: 'gtm-test123',
        ANALYTICS_GOOGLE_ENABLED: 'true',
        ANALYTICS_META_ENABLED: 'false',
      },
      request: new Request('https://edenmish.com/analytics-config'),
    });
    assert.deepEqual(await googleOnly.json(), {
      gtmContainerId: 'GTM-TEST123',
      providers: { googleAnalytics: true, metaPixel: false },
      paidConversionEnabled: false,
    });

    const invalid = await analyticsConfigResponse({
      env: {
        GTM_CONTAINER_ID: 'G-INVALID',
        ANALYTICS_GOOGLE_ENABLED: 'true',
        ANALYTICS_META_ENABLED: 'true',
      },
      request: new Request('https://edenmish.com/analytics-config'),
    });
    assert.deepEqual(await invalid.json(), {
      gtmContainerId: '',
      providers: { googleAnalytics: false, metaPixel: false },
      paidConversionEnabled: false,
    });
  });

  test('Enables paid claims only on the exact configured Shopify return origin', async () => {
    const env = {
      GTM_CONTAINER_ID: 'GTM-TEST123',
      ANALYTICS_GOOGLE_ENABLED: 'true',
      ANALYTICS_CONVERSION_ORIGIN: 'https://edenmish.com',
    };
    const canonical = await analyticsConfigResponse({
      env,
      request: new Request('https://edenmish.com/analytics-config'),
    });
    assert.equal((await canonical.json()).paidConversionEnabled, true);

    const preview = await analyticsConfigResponse({
      env,
      request: new Request('https://feature.edenmish-staging.pages.dev/analytics-config'),
    });
    assert.equal((await preview.json()).paidConversionEnabled, false);

    const disabled = await analyticsHarness({
      consent: { googleAnalytics: 'granted', metaPixel: 'denied' },
      config: {
        gtmContainerId: 'GTM-TEST123',
        providers: { googleAnalytics: true, metaPixel: false },
        paidConversionEnabled: false,
      },
    });
    assert.equal(disabled.window.edenAnalytics.getConversionContext(), null);
    assert.equal(disabled.session.has('edenmish_paid_conversion_v1'), false);

    const enabled = await analyticsHarness({
      consent: { googleAnalytics: 'granted', metaPixel: 'denied' },
    });
    assert.equal(
      enabled.window.edenAnalytics.getConversionContext(),
      '0102030405060708090a0b0c0d0e0f10',
    );
  });

  test('Retries pending and transient paid-conversion observations with backoff', async () => {
    let observations = 0;
    const credential = '0123456789abcdef0123456789abcdef';
    const analyticsState = await analyticsHarness({
      consent: { googleAnalytics: 'granted', metaPixel: 'denied' },
      pathname: '/thank-you.html',
      conversionCredential: credential,
      immediateTimers: false,
      fetchHandler: async () => {
        observations += 1;
        if (observations === 1) throw new Error('temporary network failure');
        if (observations === 2) {
          return { ok: true, status: 202, json: async () => ({ status: 'pending' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ event: 'paid_order', value: 50, currency: 'ILS' }),
        };
      },
    });

    assert.equal(observations, 1);
    assert.equal(analyticsState.timers.length, 1);
    assert.equal(analyticsState.timers[0].delay, 1000);
    analyticsState.timers.shift().callback();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(observations, 2);
    assert.equal(analyticsState.timers.length, 1);
    assert.equal(analyticsState.timers[0].delay, 2000);
    analyticsState.timers.shift().callback();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(observations, 3);
    assert.ok(
      analyticsState.window.dataLayer.some(item => item?.event === 'eden_paid_order'),
      'verified paid event should be dispatched after a successful retry',
    );
    assert.equal(analyticsState.session.has('edenmish_paid_conversion_v1'), false);
    assert.match(analytics, /CONVERSION_MAX_ATTEMPTS = 30/);
  });

  test('Instruments the agreed funnel events without treating payment start as purchase', () => {
    const booking = readPage('booking.html');
    const tracking = readPage('track.html');
    const cancellation = readPage('cancel.html');
    assertContains(analytics, '"booking_started"', 'booking start event');
    assertContains(booking, 'track("booking_submitted"', 'successful booking event');
    assertContains(booking, 'track("payment_started"', 'payment redirect event');
    assertContains(tracking, 'track("tracking_opened"', 'verified tracking event');
    assertContains(cancellation, "track('cancellation_submitted'", 'cancellation event');
    assertContains(analytics, 'track("whatsapp_clicked"', 'WhatsApp click event');
    assertContains(analytics, 'clean.event = "eden_" + name', 'namespaced dataLayer event');
    assertContains(analytics, 'eden_page_path', 'namespaced dataLayer field');
    assertContains(analytics, '"paid_order"', 'authoritative paid-order event');
    assertContains(readPage('thank-you.html'), '<script src="/assets/api-origin.js" defer></script>', 'paid conversion API routing');
    assert.ok(!analytics.includes('"purchase"'), 'browser analytics must use the reviewed event namespace');
  });

  test('Publishes disclosure, preference controls, and the required CSP allowlist', () => {
    const privacy = readPage('privacy.html');
    assertContains(privacy, 'Google Tag Manager וכלי המדידה הלא חיוניים', 'opt-in disclosure');
    assertContains(privacy, 'data-analytics-settings', 'preference control');
    assertContains(headers, 'https://www.googletagmanager.com', 'Google script CSP');
    assertContains(headers, 'https://connect.facebook.net', 'Meta script CSP');
    assertContains(headers, 'https://www.google-analytics.com', 'Google collection CSP');
    assertContains(headers, 'Referrer-Policy: no-referrer', 'sensitive same-origin referrer protection');
  });
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
  test('Homepage cache-busts the current compiled stylesheet', () => {
    assert.match(
      readPage('index.html'),
      /href="\/assets\/styles\.css\?v=[^"]+"/,
      'homepage stylesheet URL must include a non-empty build fingerprint',
    );
  });
});

describe('Frontend: Booking form', () => {
  const html = readPage('booking.html');

  test('Uses a seven-stage progressive RTL order flow without removing the canonical fields', () => {
    assertContains(html, 'id="booking-stepper"', 'guided order stepper');
    assert.equal((html.match(/class="booking-step order-layer/g) || []).length, 7, 'exactly seven guided stages should render');
    assertContains(html, 'data-step="1"', 'package-size stage');
    assertContains(html, 'data-step="7"', 'review stage');
    assertContains(html, 'שלב 1 מתוך 7', 'RTL progress status');
    assertContains(html, 'id="flow-next"', 'step continuation action');
    assertContains(html, 'id="flow-back"', 'step back action');
    assertContains(html, 'validateFlowStep', 'per-stage validation');
    assertContains(html, 'showFlowStep(currentStep+1)', 'progressive reveal');
    assertContains(html, 'width:min(calc(100% - (2 * var(--order-gutter))),960px)', 'shared responsive action width');
    assertContains(html, '.order-shell{width:min(100%,960px);margin-inline:auto}', 'shared centered content width');
    assertContains(html, 'direction:rtl', 'RTL step rail');
  });

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

  test('Supports authenticated business-wallet quotes and one-tap reservations', () => {
    assertContains(html, 'BUSINESS_REQUESTED', 'explicit business entry mode');
    assertContains(html, 'let BUSINESS_MODE = BUSINESS_REQUESTED', 'automatic business mode state');
    assertContains(html, '/api/business/me', 'business session lookup');
    assertContains(html, 'if(BUSINESS_REQUESTED)location.assign', 'explicit-login redirect only');
    assertContains(html, 'await businessModeReady', 'submit waits for automatic session lookup');
    assertContains(html, '/api/business/quote', 'plan-rate quote');
    assertContains(html, 'payload.use_wallet = true', 'wallet order marker');
    assertContains(html, '"Idempotency-Key"', 'wallet idempotency header');
    assertContains(html, 'credentials: BUSINESS_MODE ? "include"', 'credentialed business request');
    assertContains(html, 'insufficient_credit', 'top-up recovery state');
    assertContains(html, 'data-rate-key="2:standard"', 'plan-specific price table cells');
    assertContains(html, 'price-table-title', 'active plan price-table title');
    assertContains(html, 'business-wallet-estimate', 'estimated deliveries remaining copy');
    assertContains(html, 'יתרת ₪ היא הקובעת', 'authoritative credit disclaimer');
    assertContains(html, 'availableServices.has(input.value)', 'plan service availability');
    assertContains(html, 'input.disabled=!available', 'unavailable plan service disabled');
    assertContains(html, 'EdenBusinessBooking.planServiceState(activePlan)', 'tested plan-service decision');
    assertContains(html, 'preferredInput.checked=true', 'plan service selected automatically');
    assertContains(html, 'לא כלול במסלול', 'unavailable service explanation');
    assertContains(html, 'requestAuthoritativeQuoteNow', 'immediate authoritative quote before wallet spend');
    assertContains(html, 'לא נוכתה יתרה', 'failed business quote blocks wallet spend');
    assertContains(html, 'plan_service_unavailable', 'plan restriction explanation');
    assertContains(html, 'class="sr-only peer" name="service"', 'keyboard-focusable service radios');
  });

  test('Has terms acceptance separated from operational notifications', () => {
    assertContains(html, 'id="agree-terms"', 'terms checkbox');
    assertContains(html, 'תקנון', 'terms link');
    assertContains(html, 'מדיניות פרטיות', 'privacy link');
    assertContains(html, 'אין חובה חוקית למסור', 'privacy collection notice');
    assertContains(html, 'כולל אישור והוכחת מסירה', 'transactional POD email disclosure');
    assertContains(html, 'יישלחו לכתובת הדוא״ל שמסרתם', 'transactional email delivery disclosure');
    assertContains(html, 'יישלח רק לאחר הסכמה נפרדת', 'separate phone-channel consent');
    assertContains(html, 'id="phone-pod-opt-in"', 'optional WhatsApp POD-link consent');
    assertContains(html, 'phone_delivery_link_opt_in:', 'persisted phone-link consent payload');
    assertContains(html, 'הסכמה זו אינה כוללת דיוור שיווקי', 'no bundled marketing consent');
    assert.ok(!html.includes('הנני מסכים/ה לקבל עדכונים'), 'transaction acceptance must not be bundled with communications consent');
    assertContains(
      html,
      'פרטי כרטיס האשראי אינם נשמרים במערכות EdenMish. התשלום המאובטח מתבצע באמצעות ספק תשלום חיצוני.',
      'accurate hosted-payment disclosure',
    );
  });

  test('Uses Places API (New) with a plain-input fallback', () => {
    assertContains(html, '/maps-key', 'maps-key endpoint');
    assertContains(html, '__initAutocomplete', 'autocomplete callback');
    assertContains(html, 'id="f-pickup-places" hidden', 'pickup widget mount');
    assertContains(html, 'id="f-dropoff-places" hidden', 'dropoff widget mount');
    assertContains(html, 'name="pickup_address"', 'pickup submission mirror');
    assertContains(html, 'name="dropoff_address"', 'dropoff submission mirror');
    assertContains(html, 'google.maps.importLibrary("places")', 'dynamic Places library import');
    assertContains(html, 'PlaceAutocompleteElement', 'new autocomplete element');
    assertContains(html, '"gmp-select"', 'new place-selection event');
    assertContains(html, 'placePrediction.toPlace()', 'new Place conversion');
    assertContains(html, 'place.fetchFields({fields:["formattedAddress","location","addressComponents"]})', 'minimal Place fields');
    assertContains(html, 'includedRegionCodes=["il"]', 'Israel restriction');
    assertContains(html, 'locationRestriction=bounds', 'Gush-Dan bounds restriction');
    assertContains(html, 'input.value=(widget&&typeof widget.value==="string"?widget.value:"").trim()', 'typed widget value mirror');
    assertContains(html, 'widget.addEventListener("gmp-error"', 'Places request failure fallback');
    assertContains(html, 'להמשיך עם כתובת מלאה שהוקלדה ידנית', 'manual-address fallback copy');
    assertContains(html, 'placesAutocompleteReady=true', 'successful all-widget activation');
    assertContains(html, 'using plain address fields', 'graceful fallback');
    assert.ok(!html.includes('נא לבחור כתובת איסוף מהרשימה'), 'manual pickup address must not be blocked');
    assert.ok(!html.includes('נא לבחור כתובת יעד מהרשימה'), 'manual dropoff address must not be blocked');
    assert.ok(!html.includes('new google.maps.places.Autocomplete'), 'canonical booking must not instantiate the legacy widget');
    assert.ok(!html.includes('place_changed'), 'canonical booking must not use the legacy selection event');
  });

  test('Uses Route Matrix for driving distance with a stale-response guard', () => {
    assertContains(html, 'google.maps.importLibrary("routes")', 'dynamic Routes library import');
    assertContains(html, 'RouteMatrix.computeRouteMatrix', 'new route matrix request');
    assertContains(html, 'fields:["distanceMeters","condition"]', 'minimal route matrix field mask');
    assertContains(html, 'matrix.rows[0].items', 'new route matrix response shape');
    assertContains(html, 'item.condition!=="ROUTE_EXISTS"', 'missing-route rejection');
    assertContains(html, 'geo.pickupLat!==requestCoordinates.pickupLat', 'stale route response guard');
    assertContains(html, 'using quote fallback', 'route failure fallback');
    assert.ok(!html.includes('new google.maps.DistanceMatrixService'), 'canonical booking must not use the legacy distance service');
  });

  test('Has area gate (Gush-Dan bounds)', () => {
    assertContains(html, 'inGushDanBounds', 'coordinate gate');
    assert.ok(!html.includes('const EDEN_ZONES'), 'the funnel must not duplicate the Worker city-zone list');
    assert.ok(!html.includes('const ZONES'), 'the funnel must not duplicate pricing zones');
  });

  test('Uses the Worker quote as the authoritative price with a bounded fallback', () => {
    assertContains(html, '/api/quote', 'authoritative quote endpoint');
    assertContains(html, 'requestAuthoritativeQuote', 'debounced quote request');
    assertContains(html, 'sequence!==quoteState.sequence', 'stale response guard');
    assertContains(html, 'renderAuthoritativeQuote', 'server quote renderer');
    assertContains(html, 'activeQuote&&!activeQuote.available', 'server unavailable-route submission gate');
    assertContains(html, 'FALLBACK_BASE', 'offline starting-price fallback');
    assertContains(html, 'הערכת מינימום בלבד', 'fallback disclosure');
    assertContains(html, 'geo[which+"Lat"]=null', 'edited-address stale quote invalidation');
    assertContains(html, 'id="price-val"', 'live price value');
    assertContains(html, 'aria-live="polite"', 'accessible price updates');
    assert.ok(!html.includes('/api/pricing'), 'the funnel no longer reconstructs exact prices from raw rules');
  });

  test('Has scheduling (business hours)', () => {
    assertContains(html, 'schedHours', 'business hours function');
    assertContains(html, 'genWindows', 'window generation');
    assertContains(html, 'הזמנה לאותו היום עד 09:00 כולל', 'same-day Eco cutoff');
    assertContains(html, 'id="sched-custom-open"', 'explicit calendar button');
    assertContains(html, 'customDateEl.value=isoDate(c.date)', 'date-chip to editable-field synchronization');
    assertContains(html, 'customDateEl.showPicker()', 'native calendar opening');
    assertContains(html, 'lang="he-IL" dir="ltr"', 'Israeli date-field presentation');
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
    assertContains(html, 'id="coupon-toggle" class="text-label-bold text-primary hover:text-secondary transition-colors w-full text-right"', 'right-aligned coupon toggle');
    assertContains(html, 'יש לך קוד קופון?', 'coupon toggle text');
    assertContains(html, 'class="flex flex-row-reverse gap-2"', 'coupon apply action on the right');
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

  test('Redirects exact-price orders to checkout before exposing tracking', () => {
    assertContains(html, 'if (data.payment_url)', 'payment redirect guard');
    assertContains(html, 'data.payment_confirmation_token', 'signed payment confirmation capability');
    assertContains(html, 'sessionStorage.setItem(PAYMENT_CONFIRMATION_KEY', 'same-tab confirmation storage');
    assertContains(html, 'window.location.assign(data.payment_url)', 'direct Shopify checkout redirect');
    assert.ok(!html.includes('payment_url: data.payment_url'), 'payment URL must not be copied into the success-page query');
    assertContains(html, 'if (data.test && data.token)', 'paid local test-mode exception');
  });

  test('blocks high-confidence email-domain typos instead of allowing an override', () => {
    assertContains(html, '"gmail.con":"gmail.com"', 'Gmail typo correction');
    assertContains(html, '[".co.ik",".co.il"]', 'Israeli suffix typo correction');
    assertContains(html, 'invalid_email_domain', 'server domain-error handling');
    assertContains(html, 'id="email-suggest-edit"', 'manual correction action');
    assert.ok(!html.includes('id="email-suggest-keep"'), 'invalid domain must not have a keep-anyway action');
    assert.ok(!html.includes('emailSuggestText.innerHTML'), 'suggested address must not be rendered as HTML');
  });

  test('Keeps the final-submit Material icon intact across loading states', () => {
    assertContains(html, 'id="submit-btn-label"', 'submit label wrapper');
    assertContains(html, 'setSubmitButtonLabel("בודק מחיר במסלול…")', 'business quote loading label');
    assertContains(html, 'setSubmitButtonLabel("שולח הזמנה…")', 'order submission loading label');
    assert.ok(!html.includes('submitBtn.textContent'), 'loading states must not replace the icon-bearing button contents');
  });

  test('Keeps privacy preferences in the footer instead of over the fixed booking dock', () => {
    const analytics = readFileSync(join(PUB, 'assets', 'analytics.js'), 'utf8');
    assertContains(
      html,
      'type="button" data-analytics-settings hidden>העדפות פרטיות</button>',
      'non-floating booking privacy preferences control',
    );
    assertContains(
      analytics,
      'if (controls.length) return;',
      'existing page control suppresses the floating fallback',
    );
  });
});

describe('Frontend: Post-booking confirmation', () => {
  const html = readPage('success.html');

  test('Keeps tracking hidden until payment, except in paid local test mode', () => {
    assertContains(html, 'id="reference-card"', 'request reference card');
    assertContains(html, 'id="track-cta"', 'tracking CTA');
    assertContains(html, 'const paidTestMode = params.get("test") === "1" && !!token', 'paid test-mode gate');
    assertContains(html, 'if (paidTestMode)', 'tracking display gate');
    assert.ok(!html.includes('params.get("payment_url")'), 'success page must not offer prepayment tracking/payment choices');
    assertContains(html, 'קישור המעקב יישלח לאחר אישור התשלום', 'post-payment tracking copy');
  });
});

describe('Frontend: Tracking page', () => {
  const html = readPage('track.html');

  test('Has live map container', () => {
    assertContains(html, 'id="map"', 'map div');
  });

  test('Has magic-link (no forced OTP for active orders)', () => {
    assertContains(html, 'otp_pending', 'OTP check');
    assertContains(html, 'r.status === 402', 'unpaid tracking guard');
    assertContains(html, '{ credentials:"include" }', 'credentialed tracking unlock read');
    assertContains(html, 'method:"POST", credentials:"include"', 'credentialed OTP unlock');
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

  test('offers an OTP-gated corrected-address and redelivery checkout flow', () => {
    assertContains(html, 'redelivery.verification_required', 'redelivery OTP gate');
    assertContains(html, '/redelivery-address', 'corrected-address endpoint');
    assertContains(html, '/redelivery-payment', 'redelivery payment endpoint');
    assertContains(html, 'PlaceAutocompleteElement', 'routable Google Places selection');
    assertContains(html, 'ניסיון מסירה נוסף', 'retry fee disclosure');
    assertContains(html, 'התשלום התקבל. הכתובת המתוקנת ממתינה לשחרור תפעולי', 'paid pending-release state');
    assertContains(html, 'רק לאחר התשלום הכתובת תשוחרר לשליח', 'paid-only dispatch copy');
    assertContains(html, 'ACTIVE_REDELIVERY_STATES', 'active redelivery polling policy');
    assertContains(html, 'redeliveryState!==lastRedeliveryState', 'same-status redelivery refresh');
  });

  test('tracking refresh is fast only for live GPS and stops on terminal states', () => {
    const policy = trackingRefreshPolicy();
    assert.equal(policy.pollDelayForStatus('to_pickup'), 5000);
    assert.equal(policy.pollDelayForStatus('to_dropoff'), 5000);
    assert.equal(policy.pollDelayForStatus('paid'), 30000);
    assert.equal(policy.pollDelayForStatus('picked_up'), 30000);
    assert.equal(policy.isTerminalTrackStatus('delivered'), true);
    assert.equal(policy.isTerminalTrackStatus('failed'), true);
    assert.equal(policy.isTerminalTrackStatus('cancelled'), true);
    assert.equal(policy.isTerminalTrackStatus('refund_pending'), false);
    const now = 1_790_000_000_000;
    assert.equal(policy.isFreshGps(null, now), false);
    assert.equal(policy.isFreshGps({ at: now - 119_999 }, now), true);
    assert.equal(policy.isFreshGps({ at: now - 120_001 }, now), false);
  });

  test('shows live GPS only for a fresh sample and explains a missing signal', () => {
    assertContains(html, 'renderLiveGpsBadge(live,gps)', 'fresh-sample badge update');
    assertContains(html, 'id="map-placeholder-copy"', 'dynamic map placeholder');
    assertContains(html, 'ממתינים לאות המיקום הראשון מהמכשיר שלו', 'missing GPS explanation');
    assert.ok(!html.includes('$("live-badge").classList.toggle("hidden", !live)'), 'status alone must not claim GPS is active');
  });

  test('tracking distinguishes missing orders, retries transient failures, and lazy-loads Maps', () => {
    assertContains(html, 'r.status === 404', 'initial not-found handling');
    assertContains(html, 'r.status===404', 'poll not-found handling');
    assertContains(html, 'לא נמצא משלוח עם מספר המעקב הזה.', 'not-found copy');
    assertContains(html, 'לא הצלחנו לעדכן כרגע. ננסה שוב אוטומטית.', 'transient retry copy');
    assertContains(html, 'scheduleTrackPoll(lastStatus)', 'transient retry scheduling');
    assertContains(html, 'if(needsMap && !mapsReady) loadMapsForTrack()', 'lazy Maps loader');
    assertContains(html, 'if(nextToken !== token){ stopTrackPoll()', 'old token timer cleanup');
    assertContains(html, 's.onerror=()=>{ mapsRequested=false; }', 'Maps script retry guard');
    assert.ok(!html.includes('\nloadMapsForTrack();\n'), 'Maps must not load eagerly during page startup');
  });

  test('ETA targets pickup before collection and drop-off during delivery', () => {
    const helpers = trackingEtaHelpers();
    const order = { pickup_lat: 32.1, pickup_lng: 34.8, dropoff_lat: 32.2, dropoff_lng: 34.9 };
    assert.deepEqual(helpers.routeDestination({ ...order, status: 'to_pickup' }), { lat: 32.1, lng: 34.8 });
    assert.deepEqual(helpers.routeDestination({ ...order, status: 'to_dropoff' }), { lat: 32.2, lng: 34.9 });
    assert.equal(helpers.etaCopy('to_pickup', '12 דקות'), 'זמן משוער להגעה לאיסוף: 12 דקות');
    assert.equal(helpers.etaCopy('to_dropoff', '8 דקות'), 'זמן משוער להגעה למסירה: 8 דקות');
    assert.equal(helpers.etaCopy('picked_up', '8 דקות'), '');
    assert.equal(helpers.formatEtaDuration(1), 'דקה');
    assert.equal(helpers.formatEtaDuration(60001), '2 דקות');
    assert.equal(helpers.formatEtaDuration(null), '');
  });

  test('ETA route refresh is throttled for one minute but refreshes on leg changes', () => {
    const helpers = trackingEtaHelpers();
    const now = 100000;
    assert.equal(helpers.routeRefreshDue('to_pickup', now, 'to_pickup', now - 59000), false);
    assert.equal(helpers.routeRefreshDue('to_pickup', now, 'to_pickup', now - 60000), true);
    assert.equal(helpers.routeRefreshDue('to_dropoff', now, 'to_pickup', now - 1000), true);
  });

  test('renders ETA as a polite Hebrew live status overlay', () => {
    assertContains(html, 'id="eta-hint"');
    assertContains(html, 'id="map-status"');
    assertContains(html, 'aria-live="polite"');
    assertContains(html, 'google.maps.importLibrary("routes")', 'dynamic Routes library import');
    assertContains(html, 'Route.computeRoutes', 'new Route class request');
    assertContains(html, 'routingPreference:"TRAFFIC_AWARE"', 'traffic-aware ETA');
    assertContains(html, 'fields:["path","durationMillis"]', 'minimal route fields');
    assertContains(html, 'route.createPolylines', 'new route polyline rendering');
    assertContains(html, 'using straight-line fallback', 'route failure fallback');
    assert.ok(!html.includes('google.maps.DirectionsService'), 'tracking must not use the legacy directions service');
    assert.ok(!html.includes('google.maps.DirectionsRenderer'), 'tracking must not use the legacy directions renderer');
  });

  test('OTP cells expose numeric and one-time-code input semantics', () => {
    assert.equal((html.match(/class="otp-input/g) || []).length, 6);
    assert.equal((html.match(/pattern="\[0-9\]\*"/g) || []).length, 6);
    assertContains(html, 'autocomplete="one-time-code"');
    assertContains(html, 'אימות כתובת הדוא״ל');
  });

  test('pasting a full OTP into any cell distributes it and auto-submits once', async () => {
    const h = trackingOtpHarness();
    let prevented = false;
    await h.dispatch(h.inputs[3], 'paste', {
      clipboardData: { getData: () => '12 34-56' },
      preventDefault: () => { prevented = true; },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(h.inputs.map(input => input.value).join(''), '123456');
    assert.equal(h.fetchCalls(), 1);
    assert.equal(h.loadCalls(), 1);
  });

  test('autofill-shaped input auto-submits and duplicate input is guarded', async () => {
    const h = trackingOtpHarness();
    h.inputs[0].value = '654321';
    const first = h.dispatch(h.inputs[0], 'input');
    h.inputs[5].value = '1';
    const duplicate = h.dispatch(h.inputs[5], 'input');
    await Promise.all([first, duplicate]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.inputs.map(input => input.value).join(''), '654321');
    assert.equal(h.fetchCalls(), 1);
  });

  test('backspace moves focus and failed verification retains the OTP', async () => {
    const h = trackingOtpHarness({ verified: false });
    h.inputs[2].value = '';
    await h.dispatch(h.inputs[2], 'keydown', { key: 'Backspace' });
    assert.equal(h.focused(), 1);
    '123456'.split('').forEach((digit, i) => { h.inputs[i].value = digit; });
    await h.dispatch(h.elements['otp-submit'], 'click');
    assert.equal(h.inputs.map(input => input.value).join(''), '123456');
    assert.equal(h.elements['otp-msg'].textContent, 'קוד שגוי - נסו שוב.');
    assert.equal(h.elements['otp-submit'].disabled, false);
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
    assertContains(headers, 'https://places.googleapis.com', 'Places API New connection origin');
    assertContains(headers, 'https://routes.googleapis.com', 'Routes API connection origin');
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

  test('homepage exposes right-side WhatsApp and keyboard-accessible accessibility tools', () => {
    const html = readPage('index.html');
    assertContains(html, 'class="eden-floating-tools"', 'floating tools container');
    assertContains(html, 'https://wa.me/972534058498', 'business WhatsApp destination');
    assertContains(html, 'aria-label="שליחת הודעת וואטסאפ לעדן"');
    assertContains(html, 'aria-controls="eden-a11y-panel"');
    assertContains(html, 'aria-label="פתיחת כלי נגישות"');
    assertContains(html, 'if (event.key === \'Escape\'', 'Escape close behavior');
    assertContains(html, 'href="/accessibility.html">הצהרת הנגישות</a>');
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

  test('ops dashboard replaces repricing with guarded recovery for classified checkout orphans', () => {
    const html = readPage('dash.html');
    assertContains(html, 'if(o.checkout_recovery_eligible)', 'server-classified recovery gate');
    assertContains(html, 'אין לנסות ליצור חיוב נוסף', 'duplicate-charge warning');
    assertContains(html, 'onclick="recoverCheckout(', 'recovery action');
    assertContains(html, '/recover-checkout', 'recovery endpoint');
    assertContains(html, 'הפעולה אינה ניתנת לביטול', 'destructive confirmation');
  });

  test('ops authentication uses the translucent iOS-style glass treatment', () => {
    const html = readPage('dash.html');
    assertContains(html, '.dashboard-auth-card::before', 'layered translucent glass');
    assertContains(html, 'backdrop-filter:blur(26px)', 'glass blur');
    assertContains(html, 'dashboard-auth-icon', 'iOS-style app tile');
    assertContains(html, 'dashboard-auth-input', 'embedded PIN control');
    assertContains(html, 'dashboard-auth-button', 'embedded primary action');
    assertContains(html, 'inputmode="numeric"', 'mobile numeric keypad');
  });

  test('ops dashboard exposes secure per-driver invitation and QR controls', () => {
    const html = readPage('dash.html');
    assertContains(html, 'onclick="showDriverAccess()"', 'driver connection action');
    assertContains(html, 'חיבור אפליקציית נהג', 'driver connection dialog');
    assertContains(html, '/api/ops/driver/invitations', 'invitation API');
    assertContains(html, 'data.invitation.qr_svg', 'pairing QR');
    assertContains(html, 'הקוד נחשף פעם אחת', 'single-display warning');
    assertContains(html, 'function revokeDriverInvite', 'invitation revocation');
    assert.ok(!html.includes('localStorage.setItem'), 'invitation codes must not be persisted in localStorage');
  });

  test('storefront fingerprints coupled navigation assets for cache consistency', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'inject-version.js'), 'utf8');
    assertContains(script, 'ASSET_VERSION', 'shared release fingerprint');
    assertContains(script, '/assets/styles.css?v=', 'versioned stylesheet URL');
    assertContains(script, '/assets/mobile-nav.js?v=', 'versioned navigation URL');
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

  test('proof-of-delivery preserves the first selected image while its modal is open', () => {
    const html = readPage('dash.html');
    assertContains(html, 'podOrderId=id;', 'proof modal active state');
    assertContains(html, 'if(podOrderId!==null)return;', 'background refresh pause');
    assertContains(html, 'function closePod(id)', 'proof modal close reset');
    assertContains(html, 'if(d.ok){podOrderId=null;', 'successful delivery reset');
    assertContains(html, 'var input=this,f=input.files[0],ph=$("pod-photo-ph")', 'stable preview reference');
    assertContains(html, 'ph.isConnected&&input.files[0]===f', 'stale FileReader result guard');
  });
});

describe('Frontend: Ops daily summary and queue ordering', () => {
  test('uses Israel calendar days for delivered count and revenue', () => {
    const helpers = opsQueueHelpers();
    const now = Date.parse('2026-07-12T12:00:00Z');
    assert.equal(helpers.israelDateKey(Date.parse('2026-07-11T22:30:00Z')), '2026-07-12');
    const summary = helpers.dailyOpsSummary([
      { status: 'delivered', delivered_at: Date.parse('2026-07-11T22:30:00Z'), price: 50 },
      { status: 'delivered', delivered_at: Date.parse('2026-07-12T08:00:00Z'), price: '70' },
      { status: 'delivered', delivered_at: Date.parse('2026-07-11T18:00:00Z'), price: 999 },
    ], now);
    assert.equal(summary.delivered, 2);
    assert.equal(summary.revenue, 120);
  });

  test('counts only unpaid priced/payment-link orders older than one hour as stale', () => {
    const helpers = opsQueueHelpers();
    const now = Date.parse('2026-07-12T12:00:00Z');
    const summary = helpers.dailyOpsSummary([
      { status: 'priced', payment_status: 'none', created_at: now - 61 * 60 * 1000 },
      { status: 'payment_sent', payment_status: 'link_sent', created_at: now - 2 * 60 * 60 * 1000 },
      { status: 'payment_sent', payment_status: 'paid', created_at: now - 2 * 60 * 60 * 1000 },
      { status: 'payment_sent', payment_status: 'link_sent', created_at: now - 59 * 60 * 1000 },
      { status: 'received', payment_status: 'none', created_at: now - 2 * 60 * 60 * 1000 },
    ], now);
    assert.equal(summary.stalePayment, 2);
  });

  test('new paid orders stay in the inbox until dispatch starts', () => {
    const helpers = opsQueueHelpers();
    assert.equal(helpers.isActiveOrder({ status: 'picked_up' }), true);
    assert.equal(helpers.isActiveOrder({ status: 'paid' }), false);
    const html = readPage('dash.html');
    assertContains(html, '["received","priced","review","payment_sent","paid"]', 'new-order inbox statuses');
  });

  test('sorts urgent then scheduled queue windows', () => {
    const helpers = opsQueueHelpers();
    const orders = [
      { id: 4, status: 'paid', when_date: null, when_hour: null, created_at: 4 },
      { id: 3, status: 'paid', when_date: '2026-07-12', when_hour: 12, created_at: 3 },
      { id: 2, status: 'picked_up', when_date: '2026-07-12', when_hour: 10, created_at: 2 },
      { id: 1, status: 'to_pickup', urgent: 1, when_date: '2026-07-12', when_hour: 18, created_at: 1 },
    ];
    const sorted = orders.slice().sort((a, b) => helpers.compareQueueOrders(a, b, true));
    assert.deepEqual(sorted.map(o => o.id), [1, 2, 3, 4]);
  });

  test('uses the correctly spelled empty-category message', () => {
    const html = readPage('dash.html');
    assertContains(html, 'אין הזמנות בקטגוריה זו.');
    assert.ok(!html.includes('בקטטגוריה'));
  });

  test('renders the Hebrew daily summary strip in the canonical dashboard', () => {
    const html = readPage('dash.html');
    assertContains(html, 'מסירות היום');
    assertContains(html, 'הכנסה היום');
    assertContains(html, 'ממתינות מעל שעה');
  });

  test('renders Ops queue orders with the native iOS card hierarchy and six-stage progress', () => {
    const html = readPage('dash.html');
    assertContains(html, 'class="ops-queue-grid"', 'responsive queue grid');
    assertContains(html, 'class="ios-order-card ', 'native card shell');
    assertContains(html, 'class="ios-order-number">הזמנה #', 'prominent order number');
    assertContains(html, 'function queueTimingInfo(o)', 'time remaining or service-window summary');
    assertContains(html, 'function queueProgressHtml(o)', 'queue progress renderer');
    for (const label of ['נתקבלה', 'אושר', 'לאיסוף', 'נאסף', 'למסירה', 'נמסר']) {
      assertContains(html, `label:"${label}"`, `progress milestone ${label}`);
    }
  });
});

describe('Frontend: Legal pages', () => {
  const businessAddress = 'קריניצי 111, רמת גן, ישראל';

  test('Homepage exposes the verified legal business identity', () => {
    const h = readPage('index.html');
    assertContains(h, 'EdenMish מופעלת על ידי עדן אריאלי · עוסק פטור 211568928', 'visible legal identity');
    assertContains(h, '"legalName": "עדן אריאלי"', 'structured legal name');
  });

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
    const css = readFileSync(join(PUB, 'assets', 'site-nav.css'), 'utf8');
    assert.ok(!js.includes('gesturestart'), 'must not block iOS zoom');
    assert.ok(!js.includes('touches.length > 1'), 'must not block pinch zoom');
    assertContains(js, 'burger', 'hamburger builder');
    assertContains(js, 'עוסק פטור', 'legal footer line');
    assertContains(js, "new URL('site-nav.css', assetBase)", 'canonical navigation stylesheet loader');
    assertContains(css, '.eden-site-header {', 'fixed canonical header shell');
    assertContains(css, '.eden-site-mobile-nav {', 'canonical mobile menu');
    assertContains(css, 'backdrop-filter: blur(24px) saturate(150%);', 'homepage glass treatment');
  });

  test('Shared header uses one canonical order and keeps cancellation in the footer', () => {
    const js = readFileSync(join(PUB, 'assets', 'mobile-nav.js'), 'utf8');
    const headerBuilder = js.slice(0, js.indexOf('// Footer:'));
    const labels = ['בית', 'שירותים', 'מעקב משלוחים', 'לעסקים', 'אודות'];
    let previous = -1;
    for (const label of labels) {
      const position = headerBuilder.indexOf(`label: '${label}'`);
      assert.ok(position > previous, `${label} follows the canonical navigation order`);
      previous = position;
    }
    assert.ok(!headerBuilder.includes('ביטול עסקה'), 'cancellation is omitted from the header and hamburger menu');
    assertContains(headerBuilder, "setAttribute('aria-current', 'page')", 'single current-page state');
    assertContains(headerBuilder, "body > nav.fixed", 'About top navigation is discovered directly');
  });

  test('About mobile hero owns the compact booking CTA without a truck icon', () => {
    const html = readPage('about.html');
    assertContains(html, 'class="about-founder-portrait__cta" href="/booking.html"', 'portrait booking CTA');
    assert.ok(!/about-founder-portrait__cta[^]*?local_shipping[^]*?<\/a>/.test(html), 'portrait CTA has no truck icon');
  });

  test('Pages include mobile-nav.js', () => {
    for (const page of [
      'index.html', 'booking.html', 'track.html', 'about.html', 'business.html',
      'privacy.html', 'terms.html', 'refund.html', 'accessibility.html', 'cancel.html',
      'error.html', 'success.html', 'delivered.html', '404.html',
      'payment-failed.html', 'thank-you.html', 'blog/edenmish-information-security.html',
    ]) {
      const html = readPage(page);
      assertContains(html, 'mobile-nav.js', `${page} mobile-nav script`);
      assertContains(html, 'site-nav.css', `${page} canonical navigation styles`);
    }
  });

  test('Business login ships dedicated desktop and mobile 3D backgrounds', () => {
    for (const asset of [
      'edenmish-business-login-bg-desktop.webp',
      'edenmish-business-login-bg-mobile.webp',
    ]) {
      const path = join(PUB, 'assets', asset);
      assert.ok(existsSync(path), `${asset} not found`);
      assert.ok(readFileSync(path).byteLength > 80_000, `${asset} is unexpectedly small`);
    }
  });
});

describe('Frontend: first-delivery launch promotion', () => {
  test('homepage promise states the discount, eligibility, and inclusive Israel-time deadline', () => {
    const html = readPage('index.html');
    assertContains(html, 'הזמנה ראשונה, 10% פחות. שירות שיגרום לכם לחזור.', 'specific launch slogan');
    assertContains(html, '31.08.2026 בשעה 23:59:59 לפי שעון ישראל', 'unambiguous customer deadline');
    assertContains(html, 'href="/terms.html#first-delivery-promotion"', 'promotion terms link');
  });

  test('terms explicitly cover private and authenticated business eligibility', () => {
    const html = readPage('terms.html');
    assertContains(html, 'יום 31 באוגוסט 2026 כלול במלואו', 'inclusive end date');
    assertContains(html, 'בחשבון עסקי מאומת נבדקת גם זהות החשבון העסקי', 'business account identity');
    assertContains(html, 'לפני שמירת הסכום מהיתרה', 'discount before wallet reservation');
    assertContains(html, 'החריג היחיד לכלל שלפיו לא ניתן להזין קופון ידני', 'automatic wallet exception');
  });

  test('booking previews automatic eligibility but leaves final enforcement to order creation', () => {
    const html = readPage('booking.html');
    assertContains(html, '/api/coupons/auto-apply', 'automatic eligibility preview');
    assertContains(html, 'payload.promotion_expected = true', 'expected promotion guard');
    assertContains(html, 'couponState.source === "manual"', 'manual coupon remains distinct');
    assertContains(html, 'if (BUSINESS_MODE) payload.use_wallet = true', 'authenticated business preview');
    assertContains(html, 'credentials: BUSINESS_MODE ? "include" : "same-origin"', 'business session credentials');
    assertContains(html, 'data.error === "payment_checkout_unavailable"', 'retryable checkout failure handling');
    assertContains(html, 'לא חויבתם וההטבה לא נוצלה', 'promotion-preserving retry message');
  });

  test('ops dashboard exposes safe automatic first-delivery controls', () => {
    const html = readPage('dash.html');
    assertContains(html, 'id="c-auto"', 'automatic-application toggle');
    assertContains(html, 'id="c-first-delivery"', 'first-delivery eligibility toggle');
    assertContains(html, "if(first.checked){scope.value='delivery';once.checked=true;", 'safe field combination');
    assertContains(html, 'step="0.001"', 'millisecond-preserving promotion deadline');
  });
});
