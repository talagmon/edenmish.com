import { createOrder, getOrderByToken, getOrderById, getOrderByShopifyOrderId, listOrders, setOrderStatus, setOrderRating, getStatusHistory, addGps, latestGps, getGpsTrail, getRules, recordPayment, setEmailAndOtp, verifyOtp, getRateLimit, incrRateLimit, setRateLock, resetRateLimit, getDeliveryProof, upsertDeliveryProof, listRecentNotificationFailures, listNotificationsForOrder, createCancellationRequest, listCancellationRequests, runRetentionCleanup } from './db.js';
import { priceOrder, ZONE_CITIES, DEFAULT_PRICING_RULES } from './pricing.js';
import { makeSession, checkSession, getCookie, genOtp, hashOtp, timingSafeEqual } from './integrations.js';
import { createCharge, createWalletCharge, verifyShopifyWebhook, parseShopifyOrderWebhook, parseShopifyRefundWebhook } from './payment.js';
import { trackingHtml, opsHtml } from './pages.js';
import { businessAccountHtml } from './business-page.js';
import { corsFor, maskEmail, publicOrderSummary, clientIp, anonKey } from './security.js';
import { notifyEmail, notifyWhatsApp } from './notify.js';
import { normalizeIlPhone, scheduleError, validIsraeliId } from './validate.js';
import { validateCoupon, recordRedemption, listCoupons, createCoupon, updateCoupon, deleteCoupon } from './coupons.js';
import { getStatusMeta, getNextStatuses, isTerminalStatus } from './status.js';
import { shopifyWebhookRegistrar } from './shopify-webhooks.js';
import { handleDriverApi } from './driver-api.js';
import { driverDispatchStatus, startDriverShift, endDriverShift } from './driver-dispatch.js';
import { applyBusinessPlanPricing, businessSessionCookie, captureWalletReservation, cleanupBusinessSecurity, clearBusinessSessionCookie, createWalletTopup, creditWalletTopup, getBusinessSession, getBusinessSnapshot, getWalletTopup, linkWalletReservationToOrder, markWalletTopupCheckout, publicBusinessPlans, releaseWalletReservation, requestBusinessLogin, reserveWalletCredit, revokeBusinessSession, updateBusinessProfile, verifyBusinessLogin } from './business.js';
import { runDeliveryCompletionSideEffects } from './delivery-completion.js';

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const BODY_LIMIT = 64 * 1024;
async function readJson(req, maxBytes = BODY_LIMIT) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid_body'), { status: 400 }); }
}
const validCoordinate = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const trackingIsAvailable = (order) => order && (
  order.payment_status === 'paid' ||
  order.payment_status === 'paid_manual' ||
  order.payment_status === 'wallet_reserved' ||
  order.payment_status === 'wallet_paid' ||
  ['paid', 'to_pickup', 'picked_up', 'to_dropoff', 'delivered'].includes(order.status)
);
const canTransition = (from, to) => {
  if (!getStatusMeta(to)) return false;
  if (from === to) return true;
  if (getNextStatuses(from).includes(to)) return true;
  if (to === 'cancelled' && !isTerminalStatus(from)) return true;
  if (to === 'refund_pending' && ['paid', 'delivered'].includes(from)) return true;
  return false;
};
// Single source of truth for every customer-facing storefront link the Worker emits
// (tracking magic-links, delivery/rating emails, ops dash deeplink). Today STOREFRONT_BASE
// is v2.edenmish.com (staging); at apex cutover operators set STOREFRONT_BASE=https://edenmish.com
// in prod — one var change, no code edit. BOOKING_URL kept as a legacy fallback.
const storefrontBase = (env) => (env.STOREFRONT_BASE || env.BOOKING_URL || 'https://edenmish.com').replace(/\/+$/, '');
const storefrontUrl = (env, path) => storefrontBase(env) + (path || '');
const trackingUrl = (env, token) => storefrontUrl(env, `/track.html?t=${token}`);
// Business contact line for customer emails — the EdenMish business number only,
// never a private number. Single definition so the templates can't drift apart.
const SUPPORT_LINE = '<p style="color:#4b5563;font-size:13px;margin-top:14px">לשאלות: eden@edenmish.com · 053-405-8498<br>כתובת העסק למשלוח הודעות: קריניצי 111, רמת גן, ישראל</p>';
// Coupon line for customer emails (migration 008 snapshot). The darker teal keeps
// the v2 secondary accent recognizable while remaining readable on the light email surface.
const discountLineHtml = (o) => (o && o.discount_code && Number(o.discount_amount) > 0)
  ? `<div style="margin-top:6px"><span style="color:#4b5563;font-size:12px">קופון ${escHtml(o.discount_code)}: </span><b style="color:#246b62;font-size:14px">−₪${Number(o.discount_amount)}</b></div>`
  : '';
const otpEmailHtml = (otp, url) => `<div dir="rtl" style="font-family:sans-serif;font-size:16px;line-height:1.6;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:24px">הקוד שלך לאימות הכתובת ב-EdenMish:<div style="font-size:34px;font-weight:800;letter-spacing:6px;color:#5B2A86">${otp}</div>הקוד תקף 10 דקות.${url ? '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb"><a href="' + url + '" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700">מעקב המשלוח שלך ←</a></div>' : ''}</div>`;
const paymentConfirmedHtml = (env, o, url, otp) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;margin:0 auto;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:32px 24px;border:1px solid #e5e7eb;border-radius:16px"><h1 style="color:#5B2A86;font-size:26px;margin:0 0 8px">התשלום התקבל ✓</h1><p style="color:#4b5563;margin:0 0 20px;font-size:15px">תודה שבחרתם ב-EdenMish! ההזמנה מאושרת.</p><div style="background:#f7f3fa;border:1px solid #e3d7eb;border-radius:12px;padding:16px;margin-bottom:16px"><div style="margin-bottom:10px"><span style="color:#4b5563;font-size:12px">מס׳ הזמנה </span><b style="color:#1f2937">#${o.id || ''}</b></div><div><span style="color:#4b5563;font-size:12px">מחיר </span><b style="color:#246b62;font-size:20px">₪${o.price || ''}</b>${discountLineHtml(o)}</div></div><div style="margin:18px 0;padding:16px;background:#f7f3fa;border:1px solid #d6c4e3;border-radius:10px;text-align:center"><p style="margin:0 0 6px;font-size:14px;color:#4b5563">קוד האימות למעקב המשלוח:</p><div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#5B2A86">${otp || '—'}</div></div><div style="text-align:center"><a href="${url}" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">מעקב המשלוח שלי ←</a></div>${transactionDisclosureHtml(env, o)}${SUPPORT_LINE}</div>`;
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const serviceHebrew = (service) => ({ eco: 'חסכוני', standard: 'רגיל', flash: 'מהיר' }[service] || service || '—');
const transactionDisclosureHtml = (env, o) => {
  const schedule = [o.when_date, o.when_hour].filter(Boolean).map(escHtml).join(' · ') || escHtml(o.when_text || 'בתיאום');
  const priceLabel = o.price_is_estimate ? 'מחיר משוער, לפני אישור' : 'מחיר סופי';
  return `<div style="margin-top:20px;padding:14px;border:1px solid #ded5e3;border-radius:10px;font-size:13px;color:#4b5563;background:#ffffff"><b style="color:#1f2937">פרטי העסקה והעוסק</b><br>עדן אריאלי / EdenMish · עוסק פטור 211568928<br>קריניצי 111, רמת גן, ישראל · 053-405-8498 · eden@edenmish.com<br>שירות: ${escHtml(serviceHebrew(o.service))} · מועד: ${schedule}${o.package ? `<br>תכולה: ${escHtml(o.package)}` : ''}${o.pickup ? `<br>איסוף: ${escHtml(o.pickup)}` : ''}${o.dropoff ? `<br>מסירה: ${escHtml(o.dropoff)}` : ''}${o.price != null ? `<br>${priceLabel}: ₪${escHtml(o.price)} (עוסק פטור — ללא מע״מ)` : ''}<br><br>לביטול עסקה בהתאם לדין ולמדיניות: <a href="${storefrontUrl(env, '/cancel.html')}" style="color:#5B2A86">טופס ביטול מקוון</a> · <a href="${storefrontUrl(env, '/refund.html')}" style="color:#5B2A86">מדיניות ביטול</a> · <a href="${storefrontUrl(env, '/terms.html')}" style="color:#5B2A86">תקנון</a></div>`;
};
// Review-flagged orders: immediate confirmation so the customer knows what happens next
// (previously they got zero contact until after payment — a funnel dead end).
const requestReceivedHtml = (env, o) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:24px"><h2 style="color:#5B2A86;margin:0 0 8px">קיבלנו את הבקשה ✓</h2><p>עדן בודק את המסלול ויאשר את המחיר בהקדם. ברגע שהמחיר מאושר, יישלח אליכם למייל זה קישור לתשלום מאובטח.</p><table style="border-collapse:collapse;font-size:15px;color:#1f2937"><tr><td style="padding:5px 14px;color:#4b5563">מס׳ הזמנה</td><td style="padding:5px 0">${o.id || ''}</td></tr><tr><td style="padding:5px 14px;color:#4b5563">איסוף</td><td style="padding:5px 0">${escHtml(o.pickup)}</td></tr><tr><td style="padding:5px 14px;color:#4b5563">מסירה</td><td style="padding:5px 0">${escHtml(o.dropoff)}</td></tr>${o.price ? `<tr><td style="padding:5px 14px;color:#4b5563">מחיר משוער</td><td style="padding:5px 0;font-weight:700;color:#246b62">₪${o.price}</td></tr>` : ''}</table><p style="color:#4b5563;font-size:13px;margin-top:10px">לאחר התשלום יישלח קישור מעקב חי וקוד אימות למייל.</p>${transactionDisclosureHtml(env, o)}${SUPPORT_LINE}</div>`;
// Sent by /approve: the confirmed price + Shopify checkout link (previously the link was
// only copied to Eden's clipboard and the customer was never notified).
const paymentLinkHtml = (env, o, url) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:24px"><h2 style="color:#5B2A86;margin:0 0 8px">המחיר אושר ✓</h2><p>הזמנה #${o.id || ''} מוכנה לתשלום.</p><table style="border-collapse:collapse;font-size:15px;color:#1f2937"><tr><td style="padding:5px 14px;color:#4b5563">איסוף</td><td style="padding:5px 0">${escHtml(o.pickup)}</td></tr><tr><td style="padding:5px 14px;color:#4b5563">מסירה</td><td style="padding:5px 0">${escHtml(o.dropoff)}</td></tr><tr><td style="padding:5px 14px;color:#4b5563">מחיר</td><td style="padding:5px 0;font-weight:700;color:#246b62;font-size:18px">₪${o.price || ''}</td></tr></table><div style="text-align:center;margin:18px 0"><a href="${url}" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">לתשלום מאובטח ←</a></div><p style="color:#4b5563;font-size:13px">התשלום מתבצע בסביבה המאובטחת של Shopify ו‑PayPlus. EdenMish אינה שומרת פרטי כרטיס אשראי. לאחר התשלום יישלח קישור מעקב חי וקוד אימות למייל.</p>${transactionDisclosureHtml(env, o)}${SUPPORT_LINE}</div>`;

// Single post-payment boundary for both an authenticated manual payment and a
// reconciled Shopify orders/paid webhook. Callers must perform provider-specific
// validation before entering this helper. payment_status is the idempotency guard.
async function confirmPaidOrder(env, order, opts = {}) {
  if (!order) return { order: null, unchanged: true };
  if (order.payment_method === 'wallet') return { order, unchanged: true };
  if (order.payment_status === 'paid') return { order, unchanged: true };

  const paidAt = Date.now();
  const paidAmount = Number(opts.amountNis ?? order.price);
  if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new Error('invalid_paid_amount');

  const customerEmail = order.email || opts.customerEmail || null;
  const orderFields = { ...(opts.orderFields || {}), payment_status: 'paid' };
  await setOrderStatus(env.DB, order.id, 'paid', orderFields);
  await recordPayment(env.DB, order.id, {
    amount: Math.round(paidAmount * 100),
    status: 'paid',
    payplus_id: opts.paymentRef == null ? null : String(opts.paymentRef),
    paid_at: paidAt,
  });

  const paidOrder = { ...order, ...orderFields, status: 'paid', email: customerEmail };
  if (customerEmail && env.SENDGRID_API_KEY) {
    const otp = genOtp();
    await setEmailAndOtp(env.DB, order.id, customerEmail, await hashOtp(env, otp), paidAt + 10 * 60 * 1000);
    await notifyEmail(env, env.DB, {
      orderId: order.id,
      template: 'customer_payment_confirmation',
      recipient: customerEmail,
      subject: 'התשלום התקבל ✓ — קוד אימות וקישור למעקב',
      html: paymentConfirmedHtml(env, paidOrder, trackingUrl(env, order.token), otp),
    });
  }

  await notifyEmail(env, env.DB, {
    orderId: order.id,
    template: 'ops_payment_received',
    recipient: env.OPS_EMAIL,
    subject: `תשלום התקבל #${order.id} — ₪${order.price}`,
    html: `${escHtml(order.name)} · ${escHtml(order.pickup)} → ${escHtml(order.dropoff)}<br>המתינו לאישור ויציאה לדרך ב- ops.edenmish.com`,
  });
  await notifyWhatsApp(env, env.DB, {
    orderId: order.id,
    template: 'ops_payment_received',
    recipient: env.WHATSAPP_NUMBER,
    body: `תשלום התקבל #${order.id} — ₪${order.price}\n${order.name || ''} · ${order.pickup || ''} → ${order.dropoff || ''}\nצפייה ואישור: ${storefrontUrl(env, '/dash.html')}`,
  });

  return { order: (await getOrderById(env.DB, order.id)) || paidOrder, unchanged: false };
}

const REFUND_PAYMENT_STATES = new Set([
  'refund_pending',
  'partially_refunded',
  'refunded',
  'refund_failed',
  'refund_mismatch',
]);

async function reconcileShopifyRefund(env, order, refund = {}) {
  if (!order) return { reconciled: false, reason: 'order_not_found' };
  // Webhooks can arrive out of order. Once Shopify has confirmed the full refund,
  // a delayed refunds/create delivery must not reopen the terminal state.
  if (order.payment_status === 'refunded' && order.status === 'cancelled') {
    return { reconciled: true, unchanged: true };
  }

  const expectedCurrency = String(order.currency || 'ILS').toUpperCase();
  const refundCurrency = String(refund.currency || expectedCurrency).toUpperCase();
  if (refundCurrency !== expectedCurrency) {
    if (order.payment_status === 'refund_mismatch' && order.status === 'refund_pending') return { reconciled: false, unchanged: true };
    await setOrderStatus(env.DB, order.id, 'refund_pending', {
      payment_status: 'refund_mismatch',
      review_flag: 1,
      review_reason: 'refund_currency_mismatch',
    });
    return { reconciled: false, reason: 'currency_mismatch' };
  }

  const financialStatus = String(refund.financialStatus || '').toLowerCase();
  const successfulAmount = Number(refund.successfulAmount) || 0;
  const pendingAmount = Number(refund.pendingAmount) || 0;
  const expectedAmount = Number(order.price);
  const fullSuccessfulRefund = Number.isFinite(expectedAmount) && successfulAmount + 0.005 >= expectedAmount;

  if (financialStatus === 'refunded' || fullSuccessfulRefund) {
    if (order.payment_status === 'refunded' && order.status === 'cancelled') return { reconciled: true, unchanged: true };
    await setOrderStatus(env.DB, order.id, 'cancelled', {
      payment_status: 'refunded',
      review_flag: 0,
      review_reason: null,
    });
    return { reconciled: true, final: true };
  }

  if (financialStatus === 'partially_refunded' || successfulAmount > 0) {
    if (order.payment_status === 'partially_refunded' && order.status === 'refund_pending') return { reconciled: true, unchanged: true };
    await setOrderStatus(env.DB, order.id, 'refund_pending', {
      payment_status: 'partially_refunded',
      review_flag: 1,
      review_reason: 'partial_refund',
    });
    return { reconciled: true, partial: true };
  }

  if (refund.hasFailedTransaction && pendingAmount === 0) {
    if (order.payment_status === 'refund_failed' && order.status === 'refund_pending') return { reconciled: false, unchanged: true };
    await setOrderStatus(env.DB, order.id, 'refund_pending', {
      payment_status: 'refund_failed',
      review_flag: 1,
      review_reason: 'refund_failed',
    });
    return { reconciled: false, reason: 'refund_failed' };
  }

  if (order.payment_status === 'refund_pending' && order.status === 'refund_pending') return { reconciled: true, unchanged: true };
  await setOrderStatus(env.DB, order.id, 'refund_pending', {
    payment_status: 'refund_pending',
    review_flag: 1,
    review_reason: 'refund_pending',
  });
  return { reconciled: true, pending: true };
}

// Safe customer-facing Hebrew per validateCoupon rejection reason. Never expose the
// raw reason string alone — the UI shows `message`; `reason` is for programmatic use.
const COUPON_MESSAGES = {
  not_found: 'קוד הקופון לא תקף',
  unsupported: 'קוד הקופון לא תקף',
  inactive: 'הקופון אינו פעיל',
  not_started: 'הקופון עדיין לא פעיל',
  expired: 'פג תוקף הקופון',
  usage_limit_reached: 'הקופון מוצה',
  already_used: 'הקופון כבר מומש',
};
const couponMessage = (reason) => COUPON_MESSAGES[reason] || COUPON_MESSAGES.not_found;
// Stable customer identifier for once-per-customer coupon enforcement.
// Phone (E.164-normalized) preferred — it's required on orders; email is the fallback.
const couponCustomerKey = (b) => normalizeIlPhone(b && b.phone) || (b && b.email ? String(b.email).trim().toLowerCase() : null);

// One pricing boundary for quotes, coupon validation, and order creation. Every
// caller reads the current D1 rules and executes the same pricing engine.
async function authoritativeQuote(env, input) {
  return priceOrder(input, await getRules(env.DB));
}

function normalizeQuoteInput(input) {
  const b = { ...(input || {}) };
  const rawHour = b.when_hour;
  b.service = String(b.service || '').trim().toLowerCase();
  b.size = String(b.size || '').trim().toLowerCase();
  b.pickup_city = String(b.pickup_city || '').trim().slice(0, 100);
  b.dropoff_city = String(b.dropoff_city || '').trim().slice(0, 100);
  b.when_date = String(b.when_date || '').trim();
  b.when_hour = rawHour == null || rawHour === '' ? NaN : Number(rawHour);
  return b;
}

function quoteInputError(b) {
  if (!b.pickup_city || !b.dropoff_city) return 'missing_cities';
  if (!['eco', 'standard', 'flash'].includes(b.service)) return 'invalid_service';
  if (!['small', 'medium'].includes(b.size)) return 'invalid_size';
  const m = b.when_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !Number.isInteger(b.when_hour) || b.when_hour < 0 || b.when_hour > 23) return 'invalid_schedule';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return 'invalid_schedule';
  return null;
}

async function isOps(req, env) {
  const xOps = req.headers.get('X-Ops');
  if (xOps && await checkSession(env, xOps)) return true;
  const c = getCookie(req, 'ops_sess');
  return await checkSession(env, c);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Wrangler's local HTTPS certificate is self-signed. TEST_MODE may use
    // loopback HTTP for browser QA; every non-test environment stays HTTPS-only.
    if (url.protocol === 'http:' && env.TEST_MODE !== '1') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const host = (req.headers.get('host') || '').toLowerCase();
    const path = url.pathname;
    const onFind = host.startsWith('find.') || host.startsWith('find-');
    const onOps = host.startsWith('ops.') || host.startsWith('ops-') || path.startsWith('/api/ops/');
    const cors = corsFor(req, env);
    // Shadow json() to always include CORS headers (enables cross-origin ops dashboard)
    const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors, ...extra } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (path === '/health' && req.method === 'GET') {
      return json({ ok: true, service: 'edenmish-worker' });
    }

    const driverResponse = await handleDriverApi(req, env, path);
    if (driverResponse) return driverResponse;

    // ---- passwordless business account + prepaid wallet ----
    if (path === '/business' && req.method === 'GET') {
      return html(businessAccountHtml(storefrontBase(env)));
    }

    if (path === '/api/business/plans' && req.method === 'GET') {
      return json({ plans: publicBusinessPlans() });
    }

    if (path === '/api/business/auth/request' && req.method === 'POST') {
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400); }
      try {
        const result = await requestBusinessLogin(env, req, b.email, `${url.origin}/business`);
        return json(result.ok ? { ok: true, challenge: result.challenge, ...(result.test_code ? { test_code: result.test_code, test_token: result.test_token } : {}) } : { error: result.error }, result.status || 200);
      } catch (error) {
        console.error('business_login_request_failed', error && error.message || String(error));
        return json({ error: 'login_unavailable' }, 503);
      }
    }

    if (path === '/api/business/auth/verify' && req.method === 'POST') {
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400); }
      try {
        const result = await verifyBusinessLogin(env, b);
        if (!result.ok) return json({ error: result.error }, result.status || 401);
        return json({ ok: true }, 200, { 'Set-Cookie': businessSessionCookie(result.session) });
      } catch (error) {
        console.error('business_login_verify_failed', error && error.message || String(error));
        return json({ error: 'login_unavailable' }, 503);
      }
    }

    if (path === '/api/business/logout' && req.method === 'POST') {
      await revokeBusinessSession(req, env).catch(() => {});
      return json({ ok: true }, 200, { 'Set-Cookie': clearBusinessSessionCookie() });
    }

    if (path === '/api/business/me' && req.method === 'GET') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      return json(await getBusinessSnapshot(env.DB, session));
    }

    if (path === '/api/business/profile' && req.method === 'PUT') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400); }
      return json({ ok: true, profile: await updateBusinessProfile(env.DB, session, b) });
    }

    if (path === '/api/business/quote' && req.method === 'POST') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      if (!session.plan_id) return json({ error: 'plan_required' }, 409);
      let raw; try { raw = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400); }
      const b = normalizeQuoteInput(raw);
      const inputError = quoteInputError(b);
      if (inputError) return json({ error: inputError }, 400);
      const quote = applyBusinessPlanPricing(await authoritativeQuote(env, b), session.plan_id);
      return json({ ...quote, currency: 'ILS', balance: Number(session.available_agorot || 0) / 100, balance_after: quote.available ? (Number(session.available_agorot || 0) / 100 - quote.price) : null });
    }

    if (path === '/api/business/topups' && req.method === 'POST') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400); }
      const topup = await createWalletTopup(env.DB, session, b.plan_id);
      if (!topup) return json({ error: 'invalid_plan' }, 400);
      try {
        const charge = await createWalletCharge(env, {
          id: topup.id,
          plan_id: topup.plan.id,
          plan_name_he: topup.plan.name_he,
          email: topup.email,
          company_name: topup.company_name,
        }, topup.amount);
        if (!charge || !charge.checkoutUrl) return json({ error: 'checkout_unavailable' }, 503);
        await markWalletTopupCheckout(env.DB, topup.id, charge);
        return json({ ok: true, topup_id: topup.id, checkout_url: charge.checkoutUrl });
      } catch (error) {
        console.error('business_topup_checkout_failed', error && error.message || String(error));
        return json({ error: 'checkout_unavailable' }, 503);
      }
    }

    // Verify Shopify payment/refund subscriptions. Failures are sanitized, logged,
    // exposed to authenticated ops, and retried after a cooldown.
    try {
      await shopifyWebhookRegistrar.ensure(env);
    } catch {
      // Registration diagnostics must never block booking, tracking, or ops.
      console.error('shopify_webhook_registration_unexpected');
    }

    // ---- public API (CORS) ----
    // Coupon pre-check for the booking funnel: same pricing inputs as POST /api/orders
    // + coupon_code (+ phone/email for once-per-customer checks). The price is always
    // recomputed server-side — the client never sends a price. Rate-limited per
    // (hashed) IP so discount codes can't be brute-forced.
    if (path === '/api/coupons/validate' && req.method === 'POST') {
      try {
        const k = await anonKey(env, clientIp(req));
        const rl = await incrRateLimit(env.DB, 'cpn:' + k, 60 * 1000);
        if (rl.count > 10) {
          console.log('coupon_rate_limited');
          return json({ valid: false, reason: 'rate_limited', message: 'יותר מדי ניסיונות. נסו שוב בעוד דקה' }, 429, { ...cors, 'Retry-After': '60' });
        }
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400, cors); }
      const pr = await authoritativeQuote(env, b);
      const v = await validateCoupon(env.DB, b.coupon_code, pr.price, couponCustomerKey(b));
      if (!v.valid) return json({ valid: false, reason: v.reason, message: couponMessage(v.reason) }, 200, cors);
      return json({ valid: true, code: v.code, subtotal_price: v.subtotal, discount_amount: v.discountAmount, price: v.price, title: v.title }, 200, cors);
    }

    // ---- Authoritative public quote ----
    // GET supports simple integrations; the booking funnel uses POST so customer
    // route details do not end up in URLs or intermediary logs.
    if (path === '/api/quote' && ['GET', 'POST'].includes(req.method)) {
      try {
        const k = await anonKey(env, clientIp(req));
        const rl = await incrRateLimit(env.DB, 'quote:' + k, 60 * 1000);
        if (rl.count > 60) return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '60' });
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }

      let raw;
      if (req.method === 'GET') raw = Object.fromEntries(url.searchParams.entries());
      else {
        try { raw = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400, cors); }
      }
      const b = normalizeQuoteInput(raw);
      const inputError = quoteInputError(b);
      if (inputError) return json({ error: inputError }, 400, cors);

      const quote = await authoritativeQuote(env, b);
      return json({ ...quote, available: !quote.review, currency: 'ILS' }, 200, cors);
    }

    // ---- Backward-compatible public pricing config ----
    // New funnel code uses /api/quote. Keep this endpoint for integrations that need
    // the canonical city-zone map and current D1 overrides.
    if (path === '/api/pricing' && req.method === 'GET') {
      const rules = await getRules(env.DB);
      return json({
        zones: ZONE_CITIES,
        defaults: DEFAULT_PRICING_RULES,
        overrides: rules || {},
      }, 200, { ...cors, 'Cache-Control': 'public, max-age=300' });
    }

    // Dedicated online cancellation notice (§14ט). The D1 row is authoritative
    // even if the best-effort ops email is temporarily unavailable.
    if (path === '/api/cancellations' && req.method === 'POST') {
      try {
        const key = await anonKey(env, clientIp(req));
        const rl = await incrRateLimit(env.DB, 'cancel:' + key, 24 * 60 * 60 * 1000);
        if (rl.count > 5) return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '86400' });
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }

      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400, cors); }
      const orderNumber = String(b.order_number || '').trim().slice(0, 80);
      const customerName = String(b.customer_name || '').trim().slice(0, 120);
      const identityDigits = String(b.identity_number || '').replace(/\D/g, '');
      const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
      const phone = b.phone ? normalizeIlPhone(b.phone) : null;
      const reason = String(b.reason || '').trim().slice(0, 1000) || null;
      if (!orderNumber || !customerName || !identityDigits) return json({ error: 'missing_fields' }, 400, cors);
      if (!validIsraeliId(identityDigits)) return json({ error: 'invalid_identity' }, 400, cors);
      if (!email && !phone) return json({ error: 'missing_contact' }, 400, cors);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400, cors);
      if (b.phone && !phone) return json({ error: 'invalid_phone' }, 400, cors);

      const created = await createCancellationRequest(env.DB, {
        order_number: orderNumber,
        customer_name: customerName,
        identity_last4: identityDigits.slice(-4),
        email: email || null,
        phone,
        reason,
      });

      try {
        await notifyEmail(env, env.DB, {
          orderId: null,
          template: 'ops_cancellation_request',
          recipient: env.OPS_EMAIL,
          subject: `בקשת ביטול מקוונת #${created.id} · הזמנה ${orderNumber}`,
          html: `<div dir="rtl" style="font-family:sans-serif;line-height:1.7"><h2>בקשת ביטול עסקה</h2><p><b>אסמכתא:</b> ${created.id}<br><b>הזמנה:</b> ${escHtml(orderNumber)}<br><b>שם:</b> ${escHtml(customerName)}<br><b>מספר זהות:</b> ${escHtml(identityDigits)}<br><b>דוא״ל:</b> ${escHtml(email || '—')}<br><b>טלפון:</b> ${escHtml(phone || '—')}</p>${reason ? `<p><b>פירוט:</b><br>${escHtml(reason)}</p>` : ''}<p>מועד קבלה: ${new Date(created.created_at).toISOString()}</p></div>`,
        });
      } catch (e) { console.error('cancellation_notice_email_failed'); }

      return json({ ok: true, reference: created.id, received_at: created.created_at }, 201, cors);
    }

    if (path === '/api/orders' && req.method === 'POST') {
      // Part E — IP-based abuse protection (best-effort; never blocks order creation).
      try {
        const k = await anonKey(env, clientIp(req));
        const r10 = await incrRateLimit(env.DB, 'ord:' + k, 10 * 60 * 1000);
        if (r10.count > 5) { console.log('order_rate_limited', { window: '10m' }); return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '600' }); }
        const rd = await incrRateLimit(env.DB, 'ordd:' + k, 24 * 60 * 60 * 1000);
        if (rd.count > 20) { console.log('order_rate_limited', { window: 'day' }); return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '86400' }); }
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }

      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400, cors); }
      const businessSession = b.use_wallet ? await getBusinessSession(req, env) : null;
      if (b.use_wallet && !businessSession) return json({ error: 'business_login_required' }, 401, cors);
      if (businessSession) {
        if (!businessSession.plan_id) return json({ error: 'plan_required' }, 409, cors);
        b.email = businessSession.email;
        b.customer_type = 'business';
        if (!b.name) b.name = businessSession.name || businessSession.company_name || businessSession.email;
      }
      // Part A — email is required for new public orders (tracking link + OTP go by email).
      const required = ['name', 'phone', 'email', 'pickup', 'dropoff'];
      for (const f of required) if (!b[f]) return json({ error: 'missing ' + f }, 400, cors);
      const limits = { name: 120, email: 254, pickup: 500, dropoff: 500, pickup_city: 100, dropoff_city: 100, when_text: 120, package: 120, notes: 1000 };
      for (const [field, max] of Object.entries(limits)) {
        if (b[field] != null) {
          const raw = String(b[field]).trim();
          if (raw.length > max || (required.includes(field) && !raw)) return json({ error: 'invalid ' + field }, 400, cors);
          b[field] = raw || null;
        }
      }
      b.email = String(b.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return json({ error: 'invalid email' }, 400, cors);
      // A typo'd phone is a failed delivery — normalize to E.164 or reject up front.
      const phone = normalizeIlPhone(b.phone);
      if (!phone) return json({ error: 'invalid phone' }, 400, cors);
      b = { ...b, phone };

      if (!['eco', 'standard', 'flash'].includes(b.service)) return json({ error: 'invalid service' }, 400, cors);
      if (!['small', 'medium'].includes(b.size)) return json({ error: 'invalid size' }, 400, cors);
      const dateMatch = String(b.when_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const hour = Number(b.when_hour);
      if (!dateMatch || !Number.isInteger(hour) || hour < 0 || hour > 23) return json({ error: 'invalid schedule' }, 400, cors);
      const date = new Date(Date.UTC(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3]));
      if (date.getUTCFullYear() !== +dateMatch[1] || date.getUTCMonth() !== +dateMatch[2] - 1 || date.getUTCDate() !== +dateMatch[3]) {
        return json({ error: 'invalid schedule' }, 400, cors);
      }
      for (const prefix of ['pickup', 'dropoff']) {
        const lat = b[prefix + '_lat'];
        const lng = b[prefix + '_lng'];
        if ((lat != null || lng != null) && (!validCoordinate(lat, -90, 90) || !validCoordinate(lng, -180, 180))) {
          return json({ error: 'invalid coordinates' }, 400, cors);
        }
      }

      let pr = await authoritativeQuote(env, b);
      if (businessSession) pr = applyBusinessPlanPricing(pr, businessSession.plan_id);
      const isReview = pr.review;

      // Server-side hard gates: reject out-of-zone, Flash Zone 3, outside business hours.
      if (pr.reasons.includes('out_of_zone')) return json({ error: 'out_of_zone' }, 400, cors);
      if (pr.reasons.includes('flash_unavailable_z3')) return json({ error: 'flash_unavailable_z3' }, 400, cors);
      if (pr.reasons.includes('plan_service_unavailable')) return json({ error: 'plan_service_unavailable' }, 400, cors);
      const day = date.getUTCDay();
      const invalidSchedule = scheduleError(b.service, day, hour);
      if (invalidSchedule) return json({ error: invalidSchedule }, 400, cors);

      // Optional coupon: validate against the server-computed price (incl. surcharges).
      // An invalid code REJECTS the order — never silently create at full price; the
      // customer must not be charged more than the total they were shown.
      let coupon = null;
      if (b.coupon_code && businessSession) return json({ error: 'coupon_not_available_with_wallet' }, 400, cors);
      if (b.coupon_code) {
        const v = await validateCoupon(env.DB, b.coupon_code, pr.price, couponCustomerKey(b));
        if (!v.valid) return json({ valid: false, error: 'invalid_coupon', reason: v.reason, message: couponMessage(v.reason) }, 400, cors);
        coupon = v;
      }
      // `price` on the order row is always the amount the customer pays; when a coupon
      // applied, subtotal_price/discount_* record how we got there (migration 008).
      const finalPrice = coupon ? coupon.price : pr.price;
      const discountFields = {
        subtotal_price: coupon ? coupon.subtotal : null,
        discount_code: coupon ? coupon.code : null,
        discount_amount: coupon ? coupon.discountAmount : 0,
        discount_title: coupon ? coupon.title : null,
      };

      let walletReservation = null;
      if (businessSession) {
        const idempotencyKey = req.headers.get('Idempotency-Key') || b.idempotency_key;
        if (!idempotencyKey) return json({ error: 'idempotency_key_required' }, 400, cors);
        const reservationResult = await reserveWalletCredit(env.DB, businessSession.account_id, Math.round(finalPrice * 100), idempotencyKey);
        if (!reservationResult.reserved) {
          return json({
            error: 'insufficient_credit',
            available: Number(reservationResult.available_agorot || 0) / 100,
            shortfall: Number(reservationResult.shortfall_agorot || 0) / 100,
          }, 402, cors);
        }
        walletReservation = reservationResult.reservation;
        if (walletReservation && walletReservation.order_id) {
          const existingOrder = await getOrderById(env.DB, walletReservation.order_id);
          if (existingOrder) return json({ order_id: existingOrder.id, token: existingOrder.token, tracking_url: trackingUrl(env, existingOrder.token), status: existingOrder.status, price: existingOrder.price, wallet: true, idempotent: true }, 200, cors);
        }
      }

      // 1. Create the D1 order. For exact-price orders a Shopify Draft Order is created
      //    below (PR4); the customer pays its invoice URL through Shopify + PayPlus. The
      //    Shopify webhook links the order back via _tracking_token (line property) / note.
      let created;
      try {
        created = await createOrder(env.DB, {
          ...b,
          status: businessSession ? 'paid' : (isReview ? 'review' : 'priced'),
          price: finalPrice,
          review_flag: isReview ? 1 : 0,
          review_reason: isReview ? pr.reasons.join(',') : null,
          payment_status: businessSession ? 'wallet_reserved' : 'none',
          payment_mode: businessSession ? 'wallet' : 'immediate',
          business_account_id: businessSession ? businessSession.account_id : null,
          wallet_reservation_id: walletReservation ? walletReservation.id : null,
          payment_method: businessSession ? 'wallet' : null,
          email_verified: businessSession ? 1 : 0,
          ...discountFields
        });
      } catch (error) {
        if (walletReservation) await releaseWalletReservation(env.DB, walletReservation.id).catch(() => {});
        throw error;
      }
      const token = created.token;
      const finalUrl = trackingUrl(env, token);
      if (walletReservation) {
        await linkWalletReservationToOrder(env.DB, walletReservation.id, created.id);
        await env.DB.prepare(`UPDATE orders SET email = ?, email_verified = 1, payment_mode = 'wallet' WHERE id = ?`).bind(b.email, created.id).run();
      }
      // Redemption row = what usage limits count. For limited coupons the insert is an
      // atomic guard (see recordRedemption) that closes the validate→insert TOCTOU race:
      // if a concurrent order consumed the last use, the guard rejects (recorded: false)
      // and we strip the coupon from the just-created order (restore full price so the
      // snapshot stays consistent) and reject the request — never silently charge more
      // than the customer was shown. A plain D1 hiccup (throw) stays best-effort: it
      // must not kill an already-created order.
      if (coupon) {
        let redemption = { recorded: true };
        try {
          redemption = await recordRedemption(env.DB, { orderId: created.id, code: coupon.code, customerKey: couponCustomerKey(b), priceBefore: coupon.subtotal, discountAmount: coupon.discountAmount, priceAfter: coupon.price, usageLimit: coupon.usageLimit, oncePerCustomer: coupon.appliesOncePerCustomer });
        } catch (e) { console.error('coupon_redemption_error', e && e.message ? e.message : String(e)); }
        if (!redemption.recorded) {
          await env.DB.prepare('UPDATE orders SET price = subtotal_price, subtotal_price = NULL, discount_code = NULL, discount_amount = 0, discount_title = NULL WHERE id = ?')
            .bind(created.id).run();
          // Which guard lost the race is indistinguishable from one changes=0; pick the
          // reason from which limit the coupon actually has (usage_limit takes priority).
          const reason = coupon.usageLimit != null ? 'usage_limit_reached' : 'already_used';
          console.log('coupon_guard_rejected', { order: created.id, code: coupon.code, reason });
          return json({ valid: false, error: 'invalid_coupon', reason, message: couponMessage(reason) }, 400, cors);
        }
      }

      // Set OTP hash to gate the tracking page, but DON'T email the code yet.
      // The code is regenerated and emailed AFTER payment is confirmed (webhook handler).
      if (b.email && !businessSession) {
        const otp = genOtp();
        await setEmailAndOtp(env.DB, created.id, b.email, await hashOtp(env, otp), Date.now() + 2 * 60 * 60 * 1000);
      }

      // Notify Eden (optional)
      try {
        await notifyEmail(env, env.DB, { orderId: created.id, template: 'ops_new_order', recipient: env.OPS_EMAIL, subject: `הזמנה חדשה #${created.id}${isReview ? ' — לבדיקה' : ' — ממתינה לתשלום'}`, html: `${escHtml(b.name)} · ${escHtml(b.pickup)} → ${escHtml(b.dropoff)} · ₪${escHtml(finalPrice)}${coupon ? ` (קופון ${escHtml(coupon.code)} — הנחה ₪${escHtml(coupon.discountAmount)})` : ''}${isReview ? '<br>חריג: ' + escHtml(pr.reasons.join(',')) : ''}<br><a href="${escHtml(finalUrl)}">${escHtml(finalUrl)}</a>` });
      } catch {}

      // Review orders: tell the customer what happens next (Eden confirms the price,
      // then a payment link arrives by email). Without this they heard nothing at all
      // until after payment — most would assume the order vanished.
      if (isReview && b.email) {
        try { await notifyEmail(env, env.DB, { orderId: created.id, template: 'customer_request_received', recipient: b.email, subject: `קיבלנו את הבקשה ✓ — הזמנה #${created.id} ב-EdenMish`, html: requestReceivedHtml(env, { ...b, id: created.id, price: finalPrice, price_is_estimate: true }) }); } catch {}
      }

      if (businessSession) {
        try {
          await notifyEmail(env, env.DB, { orderId: created.id, template: 'ops_new_business_order', recipient: env.OPS_EMAIL, subject: `הזמנה עסקית חדשה #${created.id} — יתרה שמורה ₪${finalPrice}`, html: `${escHtml(b.name)} · ${escHtml(b.pickup)} → ${escHtml(b.dropoff)} · מסלול ${escHtml(businessSession.plan_id)} · יתרה שמורה ₪${escHtml(finalPrice)}<br><a href="${escHtml(finalUrl)}">${escHtml(finalUrl)}</a>` });
        } catch {}
        const refreshed = await getBusinessSession(req, env);
        return json({
          order_id: created.id,
          token,
          tracking_url: finalUrl,
          status: 'paid',
          price: finalPrice,
          wallet: true,
          wallet_status: 'reserved',
          balance: refreshed ? Number(refreshed.available_agorot || 0) / 100 : undefined,
          review: false,
          reasons: [],
        }, 200, cors);
      }

      // 2. PR4 — exact-price path: Worker creates a Shopify Draft Order and returns its
      //    invoice URL. The customer pays it through Shopify checkout (PayPlus app). The
      //    Shopify orders/paid webhook reconciles it back to this order. Review/manual-quote
      //    orders skip this (Eden approves the price in ops first). If Shopify isn't
      //    configured (createCharge returns null) or it throws, paymentUrl stays null and
      //    the customer sees a request-received page for manual coordination. Tracking is
      //    never exposed until payment has been confirmed.
      // TEST MODE (no charge): skip Shopify/PayPlus and auto-mark the order paid so
      // the full tracking + ops flow can be exercised end-to-end. Double-gated — needs
      // env.TEST_MODE=1 (set ONLY in local worker/.dev.vars, gitignored) AND ?test=1 on
      // the request, so it can never affect a real customer. TEST_MODE must NEVER be set
      // on the production Worker — keep it out of wrangler.toml [vars] and never
      // `wrangler secret put TEST_MODE` in prod.
      const testMode = (env.TEST_MODE === '1' || env.TEST_MODE === 'true') && url.searchParams.get('test') === '1';
      if (testMode) {
        await setOrderStatus(env.DB, created.id, 'priced', { payment_status: 'paid' });
        try { await recordPayment(env.DB, created.id, { amount: (finalPrice || 0) * 100, status: 'paid', payplus_id: 'TEST', paid_at: Date.now() }); } catch (e) {}
        if (b.email) {
          try {
            const otp = genOtp();
            await setEmailAndOtp(env.DB, created.id, b.email, await hashOtp(env, otp), Date.now() + 10 * 60 * 1000);
            await verifyOtp(env.DB, created.id); // test mode: skip the OTP gate → tracking immediately viewable
            await notifyEmail(env, env.DB, { orderId: created.id, template: 'customer_payment_confirmation', recipient: b.email, subject: 'התשלום התקבל ✓ — קוד אימות וקישור למעקב (בדיקה)', html: paymentConfirmedHtml(env, { ...created, ...b, email: b.email, price: finalPrice, ...discountFields }, finalUrl, otp) });
          } catch (e) {}
        }
        return json({ token, tracking_url: finalUrl, payment_url: null, status: 'priced', price: finalPrice, review: false, reasons: [], test: true }, 200, cors);
      }
      let paymentUrl = null;
      if (!isReview) {
        try {
          // Discount breakdown (discount_code, etc.) is shown on the Shopify
          // checkout via applied_discount and in D1 for the booking/success/tracking
          // pages and emails.
          const charge = await createCharge(env, { ...b, id: created.id, token, price: finalPrice, ...discountFields }, finalPrice);
          if (charge && charge.checkoutUrl) {
            paymentUrl = charge.checkoutUrl;
            await setOrderStatus(env.DB, created.id, 'payment_sent', {
              payment_url: paymentUrl,
              shopify_draft_order_id: charge.draftOrderId,
              payment_status: 'link_sent',
              payment_mode: charge.mode
            });
          }
        } catch {}
      }

      return json({
        order_id: created.id,
        payment_url: paymentUrl,
        status: isReview ? 'review' : (paymentUrl ? 'payment_sent' : 'priced'),
        price: finalPrice,
        subtotal_price: coupon ? coupon.subtotal : undefined,
        discount_amount: coupon ? coupon.discountAmount : undefined,
        discount_code: coupon ? coupon.code : undefined,
        review: isReview, reasons: pr.reasons
      }, 200, cors);
    }

    if (path.startsWith('/api/orders/') && req.method === 'GET') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o) return json({ error: 'not found' }, 404, cors);
      // Tracking is a post-payment capability. The token is created with the order so it
      // can be attached to the Shopify Draft Order, but it must not reveal customer or
      // delivery data until a signed webhook (or an explicit manual-payment action) has
      // moved the order into the paid delivery lifecycle.
      if (!trackingIsAvailable(o)) return json({ error: 'payment_required' }, 402, cors);
      // Magic-link tracking: the unguessable 22-char token authorizes read-only
      // viewing — no OTP needed to see live status. OTP is re-enabled ONLY by the
      // 24-hour post-delivery privacy lock (so an old/leaked link can't harvest PII),
      // and remains available for sensitive "write" actions (address/phone changes,
      // B2B history) via /verify-otp.
      const deliveredAt = o.delivered_at ? Number(o.delivered_at) : null;
      const privacyLocked = o.status === 'delivered' && deliveredAt && (Date.now() - deliveredAt > 24 * 60 * 60 * 1000);
      if (privacyLocked && !o.email_verified) {
        return json({ order: publicOrderSummary(o), history: [], gps: null, otp_pending: true }, 200, cors);
      }
      const proofP = o.status === 'delivered' ? getDeliveryProof(env.DB, o.id) : Promise.resolve(null);
      const trailP = getGpsTrail(env.DB, o.id);
      const [history, gps, proof, trail] = await Promise.all([getStatusHistory(env.DB, o.id), latestGps(env.DB, o.id), proofP, trailP]);
      delete o.otp_hash;
      return json({ order: o, history: history.results, gps, proof, gpsTrail: trail, otp_pending: false }, 200, cors);
    }

    // ---- email OTP verify / resend (public, token-based) ----
    if (path.includes('/verify-otp') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      let b; try { b = await req.json(); } catch { b = {}; }
      const RL = 'otpv:' + token;
      const now = Date.now();
      // Lockout takes precedence (don't reveal the order exists while locked).
      const rl = await getRateLimit(env.DB, RL);
      if (rl && rl.locked_until && rl.locked_until > now) {
        return json({ verified: false, error: 'locked' }, 200, cors);
      }
      // Don't reveal whether the token exists: a missing order looks like a wrong code.
      if (!o) return json({ verified: false }, 200, cors);
      if (!o.otp_expires || o.otp_expires < now) return json({ verified: false, error: 'expired' }, 200, cors);
      const expect = await hashOtp(env, String(b.code || ''));
      if (expect === o.otp_hash) {
        await verifyOtp(env.DB, o.id);
        await resetRateLimit(env.DB, RL);
        return json({ verified: true }, 200, cors);
      }
      // Part C — max 5 failed attempts within 10 min, then lock for 15 min.
      const after = await incrRateLimit(env.DB, RL, 10 * 60 * 1000);
      if (after.count >= 5) {
        await setRateLock(env.DB, RL, now + 15 * 60 * 1000);
        console.log('otp_locked', { order: o.id });
        return json({ verified: false, error: 'locked' }, 200, cors);
      }
      console.log('otp_fail', { order: o.id, attempts: after.count });
      return json({ verified: false }, 200, cors);
    }
    if (path.includes('/resend-otp') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      const RL = 'otps:' + token;
      const now = Date.now();
      const rl = await getRateLimit(env.DB, RL);
      // Part D — min 60s between sends; honor any active lockout.
      if (rl && rl.locked_until && rl.locked_until > now) {
        console.log('resend_throttled', { reason: 'locked' });
        return json({ ok: false, error: 'throttled' }, 200, cors);
      }
      if (rl && rl.last_at && now - rl.last_at < 60 * 1000) {
        return json({ ok: false, error: 'throttled' }, 200, cors);
      }
      // Don't reveal existence: a missing token / no-email / unpaid order returns
      // the same shape as a successful send (and sends nothing). OTP is only for
      // paid customers — tracking is a post-payment tool.
      if (!o || !o.email || o.payment_status !== 'paid') return json({ ok: true }, 200, cors);
      const after = await incrRateLimit(env.DB, RL, 15 * 60 * 1000);
      if (after.count > 3) {
        await setRateLock(env.DB, RL, now + 15 * 60 * 1000);
        console.log('resend_throttled', { reason: 'over_limit', order: o.id });
        return json({ ok: false, error: 'throttled' }, 200, cors);
      }
      const otp = genOtp();
      await setEmailAndOtp(env.DB, o.id, o.email, await hashOtp(env, otp), now + 10 * 60 * 1000);
      await notifyEmail(env, env.DB, { orderId: o.id, template: 'customer_otp', recipient: o.email, subject: 'קוד האימות שלך ב-EdenMish', html: otpEmailHtml(otp, trackingUrl(env, token)) });
      return json({ ok: true }, 200, cors);
    }

    // ---- public: customer delivery rating (from v2 delivered.html) ----
    // Token-gated (22-char unguessable magic link). No OTP required — rating is
    // submitted from the delivery-confirmation email deep-link, not a sensitive
    // write. Validates 1-5; idempotent (re-submitting overwrites the rating).
    if (path.startsWith('/api/orders/') && path.endsWith('/rate') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o) return json({ ok: false, error: 'not_found' }, 404, cors);
      let b; try { b = await req.json(); } catch { b = {}; }
      const rating = Math.round(Number(b.rating));
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return json({ ok: false, error: 'invalid_rating' }, 400, cors);
      }
      await setOrderRating(env.DB, o.id, rating);
      console.log('order_rated', { order: o.id, rating });
      return json({ ok: true, rating }, 200, cors);
    }

    // ---- customer tracking page (find.) ----
    if (onFind && path.startsWith('/t/')) {
      const token = path.split('/')[2];
      return html(trackingHtml(env, token));
    }
    if (onFind && (path === '/' || path === '')) {
      return Response.redirect(storefrontBase(env), 302);
    }

    // ---- ops dashboard (ops.) ----
    if (onOps && (path === '/' || path === '')) return Response.redirect(storefrontUrl(env, '/dash.html'), 302);

    if (onOps && path === '/api/ops/login' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch { b = {}; }
      // Brute-force protection: 5 failed attempts per 10 min per (hashed) IP → 15 min lock.
      // Best-effort like the order-creation limiter — a D1 hiccup never locks Eden out.
      let RL = null;
      try {
        RL = 'opspin:' + await anonKey(env, clientIp(req));
        const now = Date.now();
        const rl = await getRateLimit(env.DB, RL);
        if (rl && rl.locked_until && rl.locked_until > now) {
          console.log('ops_login_locked');
          return json({ error: 'locked' }, 429, { 'Retry-After': '900' });
        }
      } catch (rlErr) { console.error('ops_login_rl_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }
      // HMAC both sides so the comparison leaks no timing information about the PIN.
      const pinOk = !!(b.pin && env.OPS_PIN && timingSafeEqual(await hashOtp(env, String(b.pin)), await hashOtp(env, String(env.OPS_PIN))));
      if (pinOk) {
        if (RL) await resetRateLimit(env.DB, RL);
        const session = await makeSession(env);
        return json({ ok: true }, 200, { 'Set-Cookie': `ops_sess=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` });
      }
      if (RL) {
        const after = await incrRateLimit(env.DB, RL, 10 * 60 * 1000);
        if (after.count >= 5) {
          await setRateLock(env.DB, RL, Date.now() + 15 * 60 * 1000);
          console.log('ops_login_locked', { attempts: after.count });
          return json({ error: 'locked' }, 429, { 'Retry-After': '900' });
        }
        console.log('ops_login_fail', { attempts: after.count });
      }
      return json({ error: 'invalid pin' }, 401);
    }

    if (onOps && path === '/api/ops/logout' && req.method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': 'ops_sess=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    }

    if (onOps && path === '/api/ops/driver' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      return json(await driverDispatchStatus(env));
    }

    if (onOps && path === '/api/ops/driver/shift/start' && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const result = await startDriverShift(env);
      return json({ ok: true, ...result }, result.unchanged ? 200 : 201);
    }

    if (onOps && path === '/api/ops/driver/shift/end' && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const result = await endDriverShift(env);
      return json({ ok: true, ...result });
    }

    if (onOps && path === '/api/ops/orders' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const r = await listOrders(env.DB);
      return json({
        orders: r.results,
        integrations: { shopify_webhooks: shopifyWebhookRegistrar.status() },
      });
    }

    if (onOps && path.includes('/api/ops/orders/') && path.includes('/status') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      let b; try { b = await req.json(); } catch { b = {}; }
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
      const before = await getOrderById(env.DB, id);
      if (!before) return json({ error: 'not found' }, 404);
      if (!canTransition(before.status, b.status)) return json({ error: 'invalid transition', from: before.status, to: b.status }, 409);
      if (before.status === b.status && b.status !== 'paid') return json({ ok: true, unchanged: true });
      if (b.status === 'paid') {
        if (before.payment_method === 'wallet') return json({ ok: true, unchanged: true });
        const paid = await confirmPaidOrder(env, before);
        return paid.unchanged ? json({ ok: true, unchanged: true }) : json({ ok: true, order: paid.order });
      }
      const fields = {};
      if (before.wallet_reservation_id) {
        if (b.status === 'cancelled') {
          const released = await releaseWalletReservation(env.DB, before.wallet_reservation_id, before.id);
          if (!released.released && !released.unchanged) return json({ error: 'wallet_release_failed' }, 409);
          fields.payment_status = 'wallet_released';
        } else if (['to_pickup', 'picked_up', 'to_dropoff', 'delivered'].includes(b.status)) {
          const captured = await captureWalletReservation(env.DB, before.wallet_reservation_id, before.id);
          if (!captured.captured && !captured.unchanged) return json({ error: 'wallet_capture_failed' }, 409);
          fields.payment_status = 'wallet_paid';
        }
      }
      if (b.status === 'picked_up') fields.picked_up_at = Date.now();
      if (b.status === 'delivered') { fields.delivered_at = Date.now(); fields.payment_status = fields.payment_status || (before.payment_method === 'wallet' ? 'wallet_paid' : 'paid'); }
      await setOrderStatus(env.DB, id, b.status, fields);
      if (b.status === 'delivered') {
        const o = await getOrderById(env.DB, id);
        if (o) {
          const { settlement } = await runDeliveryCompletionSideEffects(env, o);
          return json({ ok: true, settlement });
        }
      }
      return json({ ok: true });
    }

    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/gps') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad' }, 400); }
      if (!validCoordinate(b.lat, -90, 90) || !validCoordinate(b.lng, -180, 180)) return json({ error: 'bad coords' }, 400);
      await addGps(env.DB, id, b.lat, b.lng);
      return json({ ok: true });
    }

    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/approve') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      let b; try { b = await req.json(); } catch { b = {}; }
      const o = await getOrderById(env.DB, id);
      if (!o) return json({ error: 'not found' }, 404);
      const price = Number(b.price) || o.price;
      // A manual re-price supersedes any coupon: clear the snapshot (otherwise it would
      // corrupt the new price — draft order line = new price + stale discount) and delete
      // the redemption row so the freed use can be redeemed again.
      if (o.discount_code) {
        await env.DB.prepare('UPDATE orders SET subtotal_price=NULL, discount_code=NULL, discount_amount=0, discount_title=NULL WHERE id=?').bind(id).run();
        await env.DB.prepare('DELETE FROM coupon_redemptions WHERE order_id=?').bind(id).run();
        Object.assign(o, { subtotal_price: null, discount_code: null, discount_amount: 0, discount_title: null });
      }
      const charge = await createCharge(env, { ...o }, price);
      if (charge) {
        await env.DB.prepare('UPDATE orders SET price=?, review_flag=0, review_reason=NULL, payment_url=?, shopify_draft_order_id=?, payment_status=?, payment_mode=?, status=? WHERE id=?')
          .bind(price, charge.checkoutUrl, charge.draftOrderId, 'link_sent', charge.mode, 'payment_sent', id).run();
        await setOrderStatus(env.DB, id, 'payment_sent');
        await recordPayment(env.DB, id, { amount: price * 100, status: 'link_sent', url: charge.checkoutUrl });
        // Email the customer the approved price + checkout link. This was the funnel's
        // missing step: the link existed only on Eden's clipboard and customers waiting
        // on a price confirmation were never notified.
        let emailed = false;
        if (o.email) {
          try {
            const sent = await notifyEmail(env, env.DB, { orderId: id, template: 'customer_payment_link', recipient: o.email, subject: `המחיר אושר ✓ — קישור לתשלום הזמנה #${id}`, html: paymentLinkHtml(env, { ...o, id, price }, charge.checkoutUrl) });
            emailed = !!(sent && sent.ok);
          } catch {}
        }
        return json({ ok: true, payment_url: charge.checkoutUrl, emailed });
      }
      // No Shopify credentials configured — fall back to priced state for WhatsApp quoting.
      await env.DB.prepare('UPDATE orders SET price=?, review_flag=0, review_reason=NULL, status=? WHERE id=?')
        .bind(price, 'priced', id).run();
      await setOrderStatus(env.DB, id, 'priced');
      return json({ ok: true, payment_url: null });
    }

    // ---- PR7: mark delivered with proof-of-delivery details ----
    // Ops-gated. Saves receiver_name/delivery_note (photo_url reserved), then marks
    // delivered (same side-effects as the status endpoint's delivered branch: settle +
    // delivery email). wasDelivered guard avoids re-emailing when Eden edits proof later.
    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/deliver') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      let b; try { b = await readJson(req, 2_100_000); } catch (e) { return json({ error: e.message }, e.status || 400); }
      const before = await getOrderById(env.DB, id);
      if (!before) return json({ error: 'not found' }, 404);
      if (before.status !== 'delivered' && !canTransition(before.status, 'delivered')) {
        return json({ error: 'invalid transition', from: before.status, to: 'delivered' }, 409);
      }
      for (const [field, max] of [['receiver_name', 120], ['delivery_note', 1000]]) {
        if (b[field] != null && String(b[field]).length > max) return json({ error: 'invalid ' + field }, 400);
      }
      if (b.photo_url && (!String(b.photo_url).startsWith('data:image/jpeg;base64,') || String(b.photo_url).length > 1_500_000)) return json({ error: 'invalid photo' }, 400);
      if (b.signature && (!String(b.signature).startsWith('data:image/png;base64,') || String(b.signature).length > 500_000)) return json({ error: 'invalid signature' }, 400);
      await upsertDeliveryProof(env.DB, id, { receiver_name: b.receiver_name, delivery_note: b.delivery_note, photo_url: b.photo_url, signature: b.signature });
      const wasDelivered = !!(before && before.status === 'delivered');
      if (!wasDelivered && before.wallet_reservation_id) {
        const captured = await captureWalletReservation(env.DB, before.wallet_reservation_id, before.id);
        if (!captured.captured && !captured.unchanged) return json({ error: 'wallet_capture_failed' }, 409);
      }
      if (!wasDelivered) await setOrderStatus(env.DB, id, 'delivered', { delivered_at: before.delivered_at || Date.now(), payment_status: before.payment_method === 'wallet' ? 'wallet_paid' : 'paid' });
      const o = await getOrderById(env.DB, id);
      if (!wasDelivered && o) {
        await runDeliveryCompletionSideEffects(env, o, { sendWhatsApp: true });
      }
      const proof = await getDeliveryProof(env.DB, id);
      return json({ ok: true, order: o, proof });
    }

    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/driver-proofs') && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
      const proofs = await env.DB.prepare(`SELECT stop_id, task_type, signer_name, note,
          photo_url, signature, created_at, updated_at
        FROM driver_task_proofs WHERE order_id = ? ORDER BY created_at`)
        .bind(id).all();
      return json({ ok: true, proofs: proofs.results || [] });
    }

    // ---- PR8: recent notification failures (ops-only, for the dashboard panel) ----
    if (onOps && path === '/api/ops/notifications/failures' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const r = await listRecentNotificationFailures(env.DB, 5);
      return json({ failures: r.results || [] });
    }

    // ---- PR9: per-order notification history (ops-only) ----
    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/notifications') && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      const r = await listNotificationsForOrder(env.DB, id);
      return json({ ok: true, notifications: r.results || [] });
    }

    // ---- Coupon management (ops-only) ----
    // Coupons live entirely in D1. Eden creates/edits them from the ops dashboard;
    // they are validated instantly with no external API call.
    if (onOps && path === '/api/ops/coupons' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const coupons = await listCoupons(env.DB);
      return json({ coupons });
    }

    if (onOps && path === '/api/ops/cancellations' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const requests = await listCancellationRequests(env.DB, Number(url.searchParams.get('limit')) || 100);
      return json({ requests: requests.results || [] });
    }
    if (onOps && path === '/api/ops/coupons' && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad' }, 400); }
      if (!b.code || !b.title || !b.value_type || b.value == null) return json({ error: 'missing fields' }, 400);
      if (!Number.isFinite(Number(b.value)) || Number(b.value) <= 0) return json({ error: 'value must be positive' }, 400);
      try {
        const c = await createCoupon(env.DB, b);
        return json({ ok: true, coupon: c });
      } catch (err) {
        if (err.message === 'coupon_exists') return json({ error: 'code already exists' }, 409);
        throw err;
      }
    }
    if (onOps && path.includes('/api/ops/coupons/') && req.method === 'PUT') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const code = String(path.split('/')[4]).trim().toUpperCase();
      if (!code) return json({ error: 'bad code' }, 400);
      let b; try { b = await req.json(); } catch { b = {}; }
      const c = await updateCoupon(env.DB, code, b);
      if (!c) return json({ error: 'not found' }, 404);
      return json({ ok: true, coupon: c });
    }
    if (onOps && path.includes('/api/ops/coupons/') && req.method === 'DELETE') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const code = String(path.split('/')[4]).trim().toUpperCase();
      if (!code) return json({ error: 'bad code' }, 400);
      const c = await deleteCoupon(env.DB, code);
      if (!c) return json({ error: 'not found' }, 404);
      return json({ ok: true, coupon: c });
    }

    // ---- Shopify webhooks (PayPlus remains behind Shopify) ----
    // orders/paid reconciles capture; refunds/create starts refund reconciliation;
    // orders/updated finalizes refunded / partially_refunded financial states.
    if (path === '/webhooks/shopify' && req.method === 'POST') {
      const rawBody = await req.text();
      const hmac = req.headers.get('X-Shopify-Hmac-SHA256') || '';
      if (!(await verifyShopifyWebhook(env, rawBody, hmac))) return json({ error: 'invalid signature' }, 401);
      let b; try { b = JSON.parse(rawBody); } catch { return json({ error: 'bad json' }, 400); }
      const topic = String(req.headers.get('X-Shopify-Topic') || 'orders/paid').toLowerCase();
      if (!['orders/paid', 'orders/updated', 'refunds/create'].includes(topic)) {
        return json({ received: true, reconciled: false });
      }

      if (topic === 'refunds/create') {
        const refund = parseShopifyRefundWebhook(b);
        if (!refund.shopifyOrderId) return json({ received: true, reconciled: false });
        const o = await getOrderByShopifyOrderId(env.DB, refund.shopifyOrderId);
        if (!o) return json({ received: true, reconciled: false });
        const result = await reconcileShopifyRefund(env, o, refund);
        return json({ received: true, reconciled: !!result.reconciled });
      }

      const parsed = parseShopifyOrderWebhook(b);
      if (parsed.walletTopupToken) {
        const topup = await getWalletTopup(env.DB, parsed.walletTopupToken);
        if (!topup) return json({ received: true, reconciled: false });
        const financialStatus = String(parsed.financial_status || '').toLowerCase();
        if (financialStatus === 'refunded' || financialStatus === 'partially_refunded') {
          // A card refund and a wallet reversal are separate money movements. Freeze
          // spending for manual reconciliation instead of silently leaving spendable credit.
          await env.DB.batch([
            env.DB.prepare(`UPDATE wallet_topups SET status = 'mismatch' WHERE id = ?`).bind(topup.id),
            env.DB.prepare(`UPDATE business_accounts SET status = 'suspended', updated_at = ? WHERE id = ?`).bind(Date.now(), topup.account_id),
          ]);
          console.error('wallet_topup_refund_requires_reconciliation', { topup: topup.id, account: topup.account_id });
          return json({ received: true, reconciled: false });
        }
        const credited = await creditWalletTopup(env.DB, topup, parsed);
        if (credited.credited && !credited.unchanged) {
          const owner = await env.DB.prepare(
            `SELECT u.email FROM business_members m JOIN business_users u ON u.id = m.user_id
             WHERE m.account_id = ? AND m.role = 'owner' LIMIT 1`
          ).bind(topup.account_id).first();
          if (owner && owner.email) {
            try {
              await notifyEmail(env, env.DB, {
                orderId: null,
                template: 'business_wallet_credited',
                recipient: owner.email,
                subject: `היתרה העסקית נטענה — ₪${Number(topup.amount_agorot) / 100}`,
                html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.7;max-width:480px;margin:auto;padding:28px;background:#fff;color:#0F172A"><h1 style="color:#5B2A86">היתרה מוכנה ✓</h1><p>הוספנו <b style="color:#246b62">₪${Number(topup.amount_agorot) / 100}</b> לחשבון העסקי שלך.</p><p><a href="${url.origin}/business" style="display:inline-block;background:#5B2A86;color:#fff;padding:12px 24px;border-radius:9px;text-decoration:none;font-weight:700">לחשבון העסקי</a></p></div>`,
              });
            } catch {}
          }
        }
        return json({ received: true, reconciled: !!credited.credited });
      }
      if (parsed.token || parsed.shopifyOrderId) {
        const o = parsed.token
          ? await getOrderByToken(env.DB, parsed.token)
          : await getOrderByShopifyOrderId(env.DB, parsed.shopifyOrderId);
        if (o) {
          const financialStatus = String(parsed.financial_status || '').toLowerCase();
          if (financialStatus === 'refunded' || financialStatus === 'partially_refunded') {
            const result = await reconcileShopifyRefund(env, o, { financialStatus, currency: parsed.currency });
            return json({ received: true, reconciled: !!result.reconciled });
          }
          if (REFUND_PAYMENT_STATES.has(o.payment_status)) return json({ received: true });
          if (parsed.paid) {
            // Idempotency: Shopify retries webhook deliveries. Re-processing would insert a
            // duplicate payment row, invalidate the customer's OTP, and re-send both emails.
            if (o.payment_status === 'paid') return json({ received: true });
            // Late or retried paid events must never roll a refund state back to paid.
            const paidAmount = Number(parsed.total);
            const expectedAmount = Number(o.price);
            const amountMatches = Number.isFinite(paidAmount) && Number.isFinite(expectedAmount) && Math.abs(paidAmount - expectedAmount) < 0.005;
            const currencyMatches = String(parsed.currency || '').toUpperCase() === String(o.currency || 'ILS').toUpperCase();
            const draftMatches = !o.shopify_draft_order_id || !parsed.draftOrderId || String(o.shopify_draft_order_id) === String(parsed.draftOrderId);
            if (!amountMatches || !currencyMatches || !draftMatches) {
              console.error('shopify_payment_mismatch', { order: o.id, amountMatches, currencyMatches, draftMatches });
              await env.DB.prepare('UPDATE orders SET payment_status=?, shopify_order_id=?, review_flag=1, review_reason=? WHERE id=?')
                .bind('mismatch', parsed.shopifyOrderId, 'payment_mismatch', o.id).run();
              return json({ received: true, reconciled: false });
            }
            // o.price is the FINAL amount (post-coupon when one applied) — the Draft
            // Order's applied_discount guarantees Shopify captured exactly this total.
            await confirmPaidOrder(env, o, {
              amountNis: paidAmount,
              customerEmail: parsed.email,
              paymentRef: parsed.shopifyOrderId,
              orderFields: { shopify_order_id: parsed.shopifyOrderId },
            });
          } else {
            // authorized but not yet captured (future Mesh/preauth mode)
            await env.DB.prepare('UPDATE orders SET shopify_order_id=?, payment_status=? WHERE id=?')
              .bind(parsed.shopifyOrderId, parsed.financial_status || 'authorized', o.id).run();
          }
        }
      }
      return json({ received: true });
    }

    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([runRetentionCleanup(env.DB), cleanupBusinessSecurity(env.DB)]).catch((error) => {
      console.error('retention_cleanup_failed', error && error.message ? error.message : String(error));
    }));
  }
};
