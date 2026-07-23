import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

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

async function analyticsHarness(consent) {
  const source = readFileSync(join(PUB, 'assets', 'analytics.js'), 'utf8');
  const appended = [];
  const window = {
    localStorage: {
      getItem() { return consent; },
      setItem() {},
    },
    location: { pathname: '/booking' },
  };
  const document = {
    head: { appendChild(node) { appended.push(node); return node; } },
    body: { appendChild() {} },
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        async: false,
        src: '',
        setAttribute() {},
        addEventListener() {},
        remove() {},
      };
    },
  };
  runInNewContext(source, {
    window,
    document,
    fetch: async () => ({ ok: true, json: async () => ({ gtmContainerId: 'GTM-TEST123' }) }),
    URL,
    Set,
  });
  await new Promise(resolve => setImmediate(resolve));
  return { window, appended };
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
  runInNewContext(`${source}\nglobalThis.__policy = { isLiveTrackStatus, isTerminalTrackStatus, pollDelayForStatus };`, context);
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

  test('publishes a branded thank-you page with one safe destination', () => {
    const html = readPage('thank-you.html');
    assertContains(html, 'התשלום התקבל בהצלחה', 'payment confirmation');
    assertContains(html, 'תודה שבחרתם ב-EdenMish', 'thank-you message');
    assertContains(html, 'src="./assets/edenmish-thank-you-bike.webp"', 'local- and web-safe thank-you artwork URL');
    assertContains(html, 'href="https://edenmish.com/"', 'main-site CTA');
    assertContains(html, 'direction: ltr;', 'desktop image-left composition');
    assertContains(html, '.message { min-height: 610px; direction: rtl; }', 'RTL message direction');
    assertContains(html, 'width: min(calc(100% - 2rem), 1120px);', 'mobile-safe page width');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-thank-you-bike.webp')), 'thank-you artwork not found');
    assert.ok(!html.includes('pay.edenmish.com'), 'thank-you page must not link back to the payment storefront');
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

  test('routes explicit payment failures separately from successful Shopify exits', () => {
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

  test('Homepage visibly lists every supported service city', () => {
    const html = readPage('index.html');
    const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const cities = [
      'תל אביב-יפו', 'רמת גן', 'גבעתיים', 'בני ברק', 'הרצליה', 'רמת השרון',
      'חולון', 'בת ים', 'קריית אונו', 'גבעת שמואל', 'אזור', 'גני תקווה',
      'סביון', 'אור יהודה', 'ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה',
      'הוד השרון', 'רמלה', 'לוד'
    ];
    assertContains(html, 'aria-label="כל אזורי השירות של EdenMish"');
    assertContains(html, 'class="service-areas-layout', 'desktop service-area grid');
    assertContains(html, 'class="service-areas-map-slot', 'desktop map anchor slot');
    assertContains(html, 'class="service-areas-map', 'desktop-centered service map');
    assertContains(html, 'class="service-areas-intro', 'service-area intro row');
    assertContains(html, 'class="service-areas-cities', 'service city-card row');
    assertContains(styles, '.service-areas-layout .service-areas-cities {\n      display: contents;', 'city cards join the desktop parent grid');
    assertContains(styles, '.service-areas-cities > :nth-child(n + 4):nth-child(-n + 6) {\n      grid-row: 3;', 'Bnei Brak group uses the second city row');
    assertContains(styles, '.service-areas-cities > :nth-child(n + 16):nth-child(-n + 18) {\n      grid-row: 7;', 'Kfar Saba group uses the sixth city row');
    assertContains(styles, '.service-areas-map-slot {', 'map anchor slot styles');
    assertContains(styles, 'align-self: stretch;', 'map anchor spans the target city rows');
    assertContains(styles, 'grid-row: 3 / 8;', 'map spans Bnei Brak through Kfar Saba rows');
    assertContains(styles, 'transform: translateY(-50%);', 'map center uses the target city-row span as its anchor');
    for (const city of cities) assertContains(html, `>${city}</span>`, `${city} service-area card`);
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
    assertContains(html, 'src="/assets/edenmish-home-hero-neon.webp"', 'motorcycle courier hero artwork with neon route trail');
    assert.ok(existsSync(join(PUB, 'assets', 'edenmish-home-hero-neon.webp')), 'neon motorcycle hero artwork not found');
    assertContains(html, 'src="/assets/edenmish-v0.mp4"', 'service-area logistics video');
    assertContains(styles, '.home-page {', 'homepage-only skin scope');
    assertContains(styles, '@media (max-width: 767px)', 'mobile presentation breakpoint');
    assertContains(styles, '.home-process-step:not(:last-child)::after', 'connected journey presentation');
    assertContains(styles, 'backdrop-filter: blur(28px) saturate(155%);', 'layered glass navigation');
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
    assertContains(homepage, 'הצטרפו ללקוחות הראשונים של EdenMish', 'honest launch-stage CTA');
  });
});

describe('Frontend: consent-aware analytics', () => {
  const analytics = readFileSync(join(PUB, 'assets', 'analytics.js'), 'utf8');
  const analyticsConfig = readFileSync(join(process.cwd(), 'functions', 'analytics-config.js'), 'utf8');
  const headers = readPage('_headers');
  const customerPages = [
    'index.html', 'about.html', 'accessibility.html', 'booking.html', 'cancel.html',
    'delivered.html', 'error.html', 'privacy.html', 'refund.html', 'success.html',
    'terms.html', 'track.html'
  ];

  test('Loads the shared consent boundary on customer pages but not the ops dashboard', () => {
    for (const page of customerPages) {
      assertContains(readPage(page), '<script src="/assets/analytics.js" defer></script>', `${page} analytics boundary`);
    }
    assert.ok(!readPage('dash.html').includes('/assets/analytics.js'), 'ops dashboard must not load marketing analytics');
  });

  test('Fails closed and loads vendor scripts only after an explicit opt-in', () => {
    assertContains(analytics, 'edenmish_analytics_consent_v1', 'versioned consent storage');
    assertContains(analytics, 'fetch("/analytics-config"', 'first-party analytics configuration');
    assertContains(analytics, 'if (consent === "granted") initializeContainer()', 'stored opt-in gate');
    assertContains(analytics, 'else if (consent === "unknown") renderBanner()', 'unknown-consent banner gate');
    assertContains(analytics, 'https://www.googletagmanager.com/gtm.js?id=', 'GTM loader');
    assert.ok(!analytics.includes('https://connect.facebook.net/en_US/fbevents.js'), 'vendors must be configured inside GTM');
    assertContains(analytics, 'updateGoogleConsent("default", "denied")', 'Google consent default');
    assertContains(analytics, 'analytics_storage: granted ? "granted" : "denied"', 'Google consent state');
    assertContains(analytics, 'event: "eden_consent_updated"', 'GTM consent update event');
    assertContains(analytics, 'רק חיוניות', 'Hebrew reject choice');
    assertContains(analytics, 'אישור מדידה', 'Hebrew accept choice');
  });

  test('Queues namespaced GTM events only after stored opt-in', async () => {
    const denied = await analyticsHarness('denied');
    assert.equal(denied.appended.length, 0, 'GTM must remain unloaded after rejection');
    assert.ok(!denied.window.dataLayer.some(item => item?.event), 'rejected visits must queue no events');

    const granted = await analyticsHarness('granted');
    assert.equal(granted.appended.length, 1, 'GTM must load exactly once after opt-in');
    assert.equal(granted.appended[0].src, 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST123');
    assert.ok(granted.window.dataLayer.some(item => item?.event === 'gtm.js'), 'GTM bootstrap event missing');
    assert.ok(granted.window.dataLayer.some(item => item?.event === 'eden_booking_started'), 'booking start event missing');

    assert.equal(granted.window.edenAnalytics.track('whatsapp_clicked', { source: 'booking', email: 'blocked@example.com' }), true);
    const contact = granted.window.dataLayer.at(-1);
    assert.equal(contact.event, 'eden_whatsapp_clicked');
    assert.equal(contact.eden_source, 'booking');
    assert.ok(!('eden_email' in contact), 'non-allowlisted fields must be discarded');
  });

  test('Uses environment-provided public IDs and excludes personal/order identifiers', () => {
    assertContains(analyticsConfig, 'env.GTM_CONTAINER_ID', 'GTM Pages variable');
    assertContains(analyticsConfig, '/^GTM-[A-Z0-9]+$/', 'GTM identifier validation');
    assert.ok(!analyticsConfig.includes('GA4_MEASUREMENT_ID'), 'GA4 ID belongs in GTM');
    assert.ok(!analyticsConfig.includes('META_PIXEL_ID'), 'Meta ID belongs in GTM');
    for (const forbidden of ['order_id', 'tracking_token', 'email', 'phone', 'address']) {
      assert.ok(!analytics.includes(forbidden), `analytics boundary must not reference ${forbidden}`);
    }
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
    assert.ok(!analytics.includes('"purchase"'), 'browser analytics must not infer paid orders');
  });

  test('Publishes disclosure, preference controls, and the required CSP allowlist', () => {
    const privacy = readPage('privacy.html');
    assertContains(privacy, 'Google Tag Manager וכלי המדידה הלא חיוניים', 'opt-in disclosure');
    assertContains(privacy, 'data-analytics-settings', 'preference control');
    assertContains(headers, 'https://www.googletagmanager.com', 'Google script CSP');
    assertContains(headers, 'https://connect.facebook.net', 'Meta script CSP');
    assertContains(headers, 'https://www.google-analytics.com', 'Google collection CSP');
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
    assertContains(html, 'באמצעות SendGrid', 'transactional email processor disclosure');
    assertContains(html, 'יישלח רק לאחר הסכמה נפרדת', 'separate phone-channel consent');
    assertContains(html, 'id="phone-pod-opt-in"', 'optional WhatsApp POD-link consent');
    assertContains(html, 'phone_delivery_link_opt_in:', 'persisted phone-link consent payload');
    assertContains(html, 'לא יישלח דיוור שיווקי מכוח אישור זה', 'no bundled marketing consent');
    assert.ok(!html.includes('הנני מסכים/ה לקבל עדכונים'), 'transaction acceptance must not be bundled with communications consent');
    assertContains(html, 'EdenMish אינה שומרת פרטי כרטיס אשראי', 'accurate hosted-payment disclosure');
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

  test('Redirects exact-price orders to checkout before exposing tracking', () => {
    assertContains(html, 'if (data.payment_url)', 'payment redirect guard');
    assertContains(html, 'window.location.assign(data.payment_url)', 'direct Shopify checkout redirect');
    assert.ok(!html.includes('payment_url: data.payment_url'), 'payment URL must not be copied into the success-page query');
    assertContains(html, 'if (data.test && data.token)', 'paid local test-mode exception');
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
  });

  test('tracking distinguishes missing orders, retries transient failures, and lazy-loads Maps', () => {
    assertContains(html, 'r.status === 404', 'initial not-found handling');
    assertContains(html, 'r.status===404', 'poll not-found handling');
    assertContains(html, 'לא נמצא משלוח עם מספר המעקב הזה.', 'not-found copy');
    assertContains(html, 'לא הצלחנו לעדכן כרגע. ננסה שוב אוטומטית.', 'transient retry copy');
    assertContains(html, 'scheduleTrackPoll(lastStatus)', 'transient retry scheduling');
    assertContains(html, 'if(needsMap && !mapsReady) loadMapsForTrack()', 'lazy Maps loader');
    assertContains(html, 'if(nextToken !== token) stopTrackPoll()', 'old token timer cleanup');
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

  test('storefront builds fingerprint the shared stylesheet for Safari', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'inject-version.js'), 'utf8');
    assertContains(script, 'ASSET_VERSION', 'stylesheet release fingerprint');
    assertContains(script, '/assets/styles.css?v=', 'versioned stylesheet URL');
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
