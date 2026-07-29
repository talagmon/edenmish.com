import {
  createOrder,
  getOrderByToken,
  getOrderById,
  getOrderByWalletReservationId,
  getOrderByShopifyOrderId,
  listOrders,
  setOrderStatus,
  setOrderRating,
  getStatusHistory,
  addGps,
  latestGps,
  getGpsTrail,
  getRules,
  recordPayment,
  setEmailAndOtp,
  verifyOtp,
  getRateLimit,
  incrRateLimit,
  setRateLock,
  resetRateLimit,
  getDeliveryProof,
  upsertDeliveryProof,
  listRecentNotificationFailures,
  listNotificationsForOrder,
  createCancellationRequest,
  listCancellationRequests,
  runRetentionCleanup,
  runHeldPackageAutoReturn,
  createRedeliveryCharge,
  getRedeliveryChargeById,
  getRedeliveryChargeByOrderId,
  getRedeliveryChargeByShopifyOrderId,
  listRedeliveryCharges,
} from './db.js';
import { priceOrder, retryFee, zoneOf, ZONE_CITIES, DEFAULT_PRICING_RULES } from './pricing.js';
import {
  makeSession,
  checkSession,
  getCookie,
  genOtp,
  hashOtp,
  timingSafeEqual,
  makeTrackingUnlock,
  checkTrackingUnlock,
  trackingUnlockCookie,
  TRACKING_UNLOCK_COOKIE,
} from './integrations.js';
import { createCharge, createWalletCharge, verifyShopifyWebhook, parseShopifyOrderWebhook, parseShopifyRefundWebhook } from './payment.js';
import { trackingHtml, opsHtml } from './pages.js';
import { businessAccountHtml } from './business-page.js';
import {
  MAX_BUSINESS_BATCH_BYTES,
  normalizeBusinessAddressInput,
  readBusinessBatchTable,
} from './business-batch.js';
import {
  BUSINESS_BATCH_AI_MODEL,
  normalizeBusinessBatchTable,
} from './business-batch-ai.js';
import {
  deleteBusinessBatchMapping,
  findBusinessBatchMappings,
  listBusinessBatchMappings,
  markBusinessBatchMappingUsed,
  saveBusinessBatchMapping,
} from './business-batch-mappings.js';
import { validateBusinessBatchAddresses } from './business-address.js';
import {
  approveBusinessBatchToken,
  businessBatchIdempotencyKey,
  signBusinessBatchToken,
  verifyBusinessBatchToken,
} from './business-batch-approval.js';
import { corsFor, maskEmail, publicOrderSummary, clientIp, anonKey } from './security.js';
import { notifyEmail } from './notify.js';
import { normalizeIlPhone, scheduleError, validIsraeliId } from './validate.js';
import {
  validateCoupon,
  findAutomaticCoupon,
  reserveFirstDeliveryClaim,
  attachFirstDeliveryClaim,
  releaseFirstDeliveryClaim,
  recordRedemption,
  recordBusinessRedemption,
  releaseBusinessRedemption,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
} from './coupons.js';
import { getStatusMeta, getNextStatuses, isTerminalStatus } from './status.js';
import { shopifyWebhookRegistrar } from './shopify-webhooks.js';
import { handleDriverApi } from './driver-api.js';
import { driverDispatchStatus, startDriverShift, endDriverShift } from './driver-dispatch.js';
import {
  createDriverInvitation,
  listActiveDrivers,
  listDriverInvitations,
  revokeDriverInvitation,
} from './driver-invitations.js';
import { applyBusinessPlanPricing, businessCouponCustomerKey, businessSessionCookie, cancelReservedBusinessOrder, cancelWalletTopup, captureWalletReservation, cleanupBusinessSecurity, clearBusinessSessionCookie, createWalletTopup, creditWalletTopup, getBusinessSession, getBusinessSnapshot, getWalletTopup, hydrateBusinessProfileFromPayment, linkWalletReservationToOrder, markWalletTopupCheckout, publicBusinessPlans, releaseWalletReservation, requestBusinessLogin, reserveWalletCredit, revokeBusinessSession, shouldHydrateBusinessProfile, updateBusinessProfile, updateReservedBusinessOrder, verifyBusinessLogin } from './business.js';
import { runDeliveryCompletionSideEffects } from './delivery-completion.js';
import {
  persistOpsDeliveryCompletion,
  persistPaidOrderAndOpsWhatsAppJob,
  processDeliveryNotificationOutbox,
} from './delivery-notification-outbox.js';
import {
  applyWhatsAppDeliveryReceipt,
  extractWhatsAppDeliveryReceipts,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
} from './whatsapp.js';
import {
  cleanupAnalyticsClaims,
  observeAnalyticsClaim,
  registerAnalyticsClaim,
} from './analytics-conversion.js';

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
async function readBytes(req, maxBytes) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  return bytes;
}
const validCoordinate = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function israelIsoDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function decodedBatchHeader(req, name) {
  const value = req.headers.get(name) || '';
  try { return decodeURIComponent(value); } catch { throw new Error('invalid_batch_settings'); }
}
function batchRowTokenData(row, idempotencyKey) {
  return {
    row_number: row.row_number,
    external_id: row.external_id,
    idempotency_key: idempotencyKey,
    recipient_name: row.recipient_name,
    recipient_phone: row.recipient_phone,
    delivery_address: row.delivery_address,
    delivery_city: row.delivery_city,
    pickup_date: row.pickup_date,
    pickup_hour: row.pickup_hour,
    package_size: row.package_size,
    reference: row.reference,
    contents: row.contents,
    notes: row.notes,
  };
}
function batchPickupTokenData(pickup, service, defaultContents, smartMapping = null) {
  return {
    address: pickup.address,
    city: pickup.city,
    service,
    default_contents: defaultContents,
    ...(smartMapping ? { smart_mapping: smartMapping } : {}),
  };
}
function batchOrderMatchesTokenData(order, row, pickup) {
  const expectedNotes = [
    row.reference ? `לקוח/ספק: ${row.reference}` : '',
    row.notes || '',
  ].filter(Boolean).join(' · ');
  const expectedPackage = row.contents || pickup.default_contents || 'חבילה קטנה';
  return (
    String(order.name || '') === String(row.recipient_name || '')
    && String(order.phone || '') === String(row.recipient_phone || '')
    && String(order.pickup || '') === String(pickup.address || '')
    && String(order.pickup_city || '') === String(pickup.city || '')
    && String(order.dropoff || '') === String(row.delivery_address || '')
    && String(order.dropoff_city || '') === String(row.delivery_city || '')
    && String(order.when_date || '') === String(row.pickup_date || '')
    && Number(order.when_hour) === Number(row.pickup_hour)
    && String(order.service || '') === String(pickup.service || '')
    && String(order.size || '') === String(row.package_size || '')
    && String(order.package || '') === expectedPackage
    && String(order.notes || '') === expectedNotes
  );
}
const trackingIsAvailable = (order) => order && (
  order.payment_status === 'paid' ||
  order.payment_status === 'paid_manual' ||
  order.payment_status === 'wallet_reserved' ||
  order.payment_status === 'wallet_paid' ||
  ['paid', 'to_pickup', 'picked_up', 'to_dropoff', 'delivered', 'cancelled'].includes(order.status)
);
const trackingPrivacyIsLocked = (order, now = Date.now()) => {
  const deliveredAt = order?.delivered_at ? Number(order.delivered_at) : null;
  return order?.status === 'delivered'
    && deliveredAt
    && now - deliveredAt > 24 * 60 * 60 * 1000;
};
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
const businessOrderConfirmedHtml = (env, o, url) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;margin:0 auto;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:32px 24px;border:1px solid #e5e7eb;border-radius:16px"><h1 style="color:#5B2A86;font-size:26px;margin:0 0 8px">המשלוח העסקי נוצר ✓</h1><p style="color:#4b5563;margin:0 0 20px;font-size:15px">ההזמנה אושרה והסכום נשמר מהיתרה העסקית.</p><div style="background:#f7f3fa;border:1px solid #e3d7eb;border-radius:12px;padding:16px;margin-bottom:16px"><div style="margin-bottom:10px"><span style="color:#4b5563;font-size:12px">מס׳ הזמנה </span><b style="color:#1f2937">#${o.id || ''}</b></div><div><span style="color:#4b5563;font-size:12px">יתרה שמורה </span><b style="color:#246b62;font-size:20px">₪${o.price || ''}</b>${discountLineHtml(o)}</div></div><div style="text-align:center"><a href="${escHtml(url)}" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">מעקב המשלוח ←</a></div>${transactionDisclosureHtml(env, o)}${SUPPORT_LINE}</div>`;
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
const redeliveryPaidHtml = (env, order, amountNis) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:24px"><h2 style="color:#5B2A86;margin:0 0 8px">התשלום למסירה החוזרת התקבל ✓</h2><p>קיבלנו תשלום בסך <b style="color:#246b62">₪${escHtml(amountNis)}</b> עבור ניסיון מסירה נוסף להזמנה #${escHtml(order.id)}.</p><p>הכתובת המתוקנת ממתינה לאישור תפעולי. נעדכן את מסלול השליח לאחר האישור.</p><div style="text-align:center;margin:18px 0"><a href="${trackingUrl(env, order.token)}" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">חזרה למעקב ←</a></div>${SUPPORT_LINE}</div>`;

async function redeliveryPublicState(DB, order) {
  if (!order || order.status !== 'failed' || !order.retained_by_driver) return null;
  const charge = await getRedeliveryChargeByOrderId(DB, order.id);
  let pending = null;
  try {
    pending = order.pending_redelivery_json ? JSON.parse(order.pending_redelivery_json) : null;
  } catch {}
  const expiresAt = Number(charge?.expires_at)
    || (order.retained_at ? Number(order.retained_at) + 24 * 60 * 60 * 1000 : null);
  const base = {
    fee: charge ? Number(charge.amount_agorot) / 100 : pending?.fee ?? null,
    currency: charge?.currency || 'ILS',
    expires_at: expiresAt,
    address: pending ? {
      dropoff: pending.dropoff,
      dropoff_detail: pending.dropoff_detail,
      dropoff_city: pending.dropoff_city,
      zone: pending.zone,
    } : null,
  };
  if (order.retained_by_driver === 'return_to_origin') {
    return { ...base, state: charge?.status === 'late_paid' ? 'late_payment_review' : 'returning' };
  }
  if (order.retained_by_driver === 'redelivery') return { ...base, state: 'released' };
  if (charge?.status === 'paid') return { ...base, state: 'paid_pending_release' };
  if (charge?.status === 'late_paid' || charge?.status === 'mismatch') {
    return { ...base, state: 'payment_review' };
  }
  if (charge?.status === 'expired') return { ...base, state: 'expired' };
  if (pending) {
    return {
      ...base,
      state: 'payment_required',
      payment_url: charge?.status === 'link_sent' ? charge.payment_url : null,
    };
  }
  return {
    ...base,
    state: 'address_required',
    verification_required: !order.email_verified,
  };
}

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
  const transition = await persistPaidOrderAndOpsWhatsAppJob(env.DB, order.id, {
    amountAgorot: Math.round(paidAmount * 100),
    paymentRef: opts.paymentRef == null ? null : String(opts.paymentRef),
    shopifyOrderId: opts.orderFields?.shopify_order_id ?? null,
    analyticsSettlement: opts.analyticsSettlement === true,
    now: paidAt,
  });
  if (!transition.transitioned) {
    return {
      order: (await getOrderById(env.DB, order.id)) || order,
      unchanged: true,
    };
  }

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
  not_applicable: 'הקופון אינו תקף לרכישה זו',
  identity_required: 'יש להשלים מספר טלפון ודוא״ל כדי לבדוק את הזכאות',
  not_new_customer: 'הטבת המשלוח הראשון אינה זמינה לפרטים האלה',
  promotion_unavailable: 'לא ניתן להחיל את ההטבה כרגע. נסו שוב בעוד מספר דקות',
};
const couponMessage = (reason) => COUPON_MESSAGES[reason] || COUPON_MESSAGES.not_found;
// Stable customer identifier for once-per-customer coupon enforcement.
// Phone (E.164-normalized) preferred — it's required on orders; email is the fallback.
const couponCustomerKey = (b) => normalizeIlPhone(b && b.phone) || (b && b.email ? String(b.email).trim().toLowerCase() : null);
const couponIdentity = (b, businessSession = null) => {
  const businessAccountId = businessSession ? Number(businessSession.account_id) : null;
  const phoneKey = normalizeIlPhone(b && b.phone);
  const emailKey = businessSession && businessSession.email
    ? String(businessSession.email).trim().toLowerCase()
    : (b && b.email ? String(b.email).trim().toLowerCase() : null);
  return {
    customerKey: businessAccountId ? businessCouponCustomerKey(businessAccountId) : (phoneKey || emailKey),
    phoneKey,
    emailKey,
    businessAccountId: businessAccountId || null,
    customerType: businessAccountId ? 'business' : 'private',
  };
};

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

function isTrustedOpsMutationOrigin(req, env) {
  if (req.headers.get('X-Ops')) return true;
  const origin = req.headers.get('Origin');
  if (!origin) return false;
  if (origin === new URL(req.url).origin) return true;
  try {
    return origin === new URL(storefrontBase(env)).origin;
  } catch {
    return false;
  }
}

export default {
  async fetch(req, env, ctx) {
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

    const driverResponse = await handleDriverApi(req, env, path, ctx);
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
        const requestedPlan = String(b.plan_id || '');
        const accountUrl = new URL(`${url.origin}/business`);
        if (publicBusinessPlans().some((plan) => plan.id === requestedPlan)) accountUrl.searchParams.set('plan', requestedPlan);
        const result = await requestBusinessLogin(env, req, b.email, accountUrl.toString());
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

    if (path === '/api/business/batch-mappings' && req.method === 'GET') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      return json({
        mappings: await listBusinessBatchMappings(env.DB, session.account_id),
      });
    }

    const businessBatchMappingMatch = path.match(/^\/api\/business\/batch-mappings\/(\d+)$/);
    if (businessBatchMappingMatch && req.method === 'DELETE') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      const mappingId = Number(businessBatchMappingMatch[1]);
      if (!Number.isSafeInteger(mappingId) || mappingId <= 0) {
        return json({ error: 'invalid_batch_mapping_id' }, 400);
      }
      const deleted = await deleteBusinessBatchMapping(
        env.DB,
        session.account_id,
        mappingId,
      );
      if (!deleted) return json({ error: 'batch_mapping_not_found' }, 404);
      return json({ ok: true, id: mappingId });
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

    if (path === '/api/business/batches/parse' && req.method === 'POST') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      try {
        const limit = await incrRateLimit(env.DB, `bizbatch:${session.account_id}`, 10 * 60 * 1000);
        if (limit.count > 10) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '600' });
      } catch (error) {
        console.error('business_batch_rate_limit_error', error && error.message ? error.message : String(error));
      }
      try {
        const bytes = await readBytes(req, MAX_BUSINESS_BATCH_BYTES);
        const pickup = normalizeBusinessAddressInput({
          street: decodedBatchHeader(req, 'X-Pickup-Street'),
          house_number: decodedBatchHeader(req, 'X-Pickup-House-Number'),
          city: decodedBatchHeader(req, 'X-Pickup-City'),
          entrance: decodedBatchHeader(req, 'X-Pickup-Entrance'),
          floor: decodedBatchHeader(req, 'X-Pickup-Floor'),
          apartment: decodedBatchHeader(req, 'X-Pickup-Apartment'),
        }, 'pickup');
        const service = decodedBatchHeader(req, 'X-Batch-Service').trim().toLowerCase();
        const defaultContents = decodedBatchHeader(req, 'X-Batch-Default-Contents').trim();
        if (!['eco', 'standard', 'flash'].includes(service)) pickup.errors.push('invalid_service');
        if (defaultContents.length > 120) pickup.errors.push('too_long_default_contents');
        const batchParseOptions = {
          fileName: req.headers.get('X-File-Name') || '',
          contentType: req.headers.get('Content-Type') || '',
          today: israelIsoDate(),
        };
        const table = readBusinessBatchTable(bytes, batchParseOptions);
        const normalizedBatch = await normalizeBusinessBatchTable(env.AI, table, {
          ...batchParseOptions,
          model: env.BUSINESS_BATCH_AI_MODEL || BUSINESS_BATCH_AI_MODEL,
          loadSavedMappings: async (signatures) => {
            try {
              return await findBusinessBatchMappings(env.DB, session.account_id, signatures);
            } catch (error) {
              console.error(
                'business_batch_mapping_lookup_failed',
                error && error.message ? error.message : String(error),
              );
              return new Map();
            }
          },
        });
        const parsedRows = normalizedBatch.rows;
        const smartImport = normalizedBatch.smart_import;
        if (normalizedBatch.import_mode === 'saved_mapping' && smartImport?.mapping_signature) {
          await markBusinessBatchMappingUsed(
            env.DB,
            session.account_id,
            smartImport.mapping_signature,
          ).catch((error) => {
            console.error(
              'business_batch_mapping_usage_failed',
              error && error.message ? error.message : String(error),
            );
          });
        }
        const pickupRow = {
          row_number: 0,
          delivery_street: pickup.street,
          delivery_house_number: pickup.house_number,
          delivery_city: pickup.city,
          delivery_entrance: pickup.entrance,
          delivery_floor: pickup.floor,
          delivery_apartment: pickup.apartment,
          delivery_address: pickup.address,
          corrections: pickup.corrections.map((correction) => ({
            ...correction,
            field: correction.field.replace(/^pickup_/, 'delivery_'),
            reason: correction.reason.replace(/^normalized_pickup_/, 'normalized_delivery_'),
          })),
          errors: pickup.errors.map((error) => error.replace(/_pickup_/, '_delivery_')),
        };
        const validated = await validateBusinessBatchAddresses([pickupRow, ...parsedRows], {
          apiKey: env.GOOGLE_PLACES_SERVER_KEY,
        });
        const [validatedPickup, ...rows] = validated;
        pickup.street = validatedPickup.delivery_street;
        pickup.house_number = validatedPickup.delivery_house_number;
        pickup.city = validatedPickup.delivery_city;
        pickup.entrance = validatedPickup.delivery_entrance;
        pickup.floor = validatedPickup.delivery_floor;
        pickup.apartment = validatedPickup.delivery_apartment;
        pickup.address = validatedPickup.delivery_address;
        pickup.corrections = validatedPickup.corrections.map((correction) => ({
          ...correction,
          field: correction.field.replace(/^delivery_/, 'pickup_'),
          reason: correction.reason.replace(/^normalized_delivery_/, 'normalized_pickup_'),
        }));
        pickup.errors = validatedPickup.errors.map((error) => error.replace(/_delivery_/, '_pickup_'));
        if (smartImport?.mapping_source === 'workers_ai') {
          const mappedFields = smartImport.mappings
            .map((mapping) => `${mapping.source_header} → ${mapping.field_label_he}`)
            .join(' · ');
          pickup.corrections.push({
            field: 'ai_file_mapping',
            from: `קובץ חופשי · גיליון ${smartImport.sheet_index + 1} · שורת כותרות ${smartImport.header_row_number}`,
            to: mappedFields,
            reason: 'ai_file_mapping',
            confidence: 'medium',
            source: 'workers_ai',
          });
        }

        await Promise.all(rows.map(async (row) => {
          if (row.errors.length) return;
          const idempotencyKey = await businessBatchIdempotencyKey(row.external_id);
          row.idempotency_key = idempotencyKey;
          row.batch_token = await signBusinessBatchToken(
            env,
            session.account_id,
            'row',
            batchRowTokenData(row, idempotencyKey),
            { approved: row.corrections.length === 0 },
          );
        }));
        const keyedRows = rows.filter((row) => row.idempotency_key);
        if (keyedRows.length) {
          const placeholders = keyedRows.map(() => '?').join(',');
          const existing = await env.DB.prepare(
            `SELECT o.*, wr.idempotency_key,
              wr.status AS reservation_status,
              wr.amount_agorot AS reserved_amount_agorot
             FROM wallet_reservations wr
             JOIN orders o ON o.id = wr.order_id
             WHERE wr.account_id = ? AND wr.idempotency_key IN (${placeholders})`
          ).bind(session.account_id, ...keyedRows.map((row) => row.idempotency_key)).all();
          const byKey = new Map((existing.results || []).map((order) => [order.idempotency_key, order]));
          for (const row of keyedRows) {
            const order = byKey.get(row.idempotency_key);
            if (!order) {
              row.import_action = 'create';
              continue;
            }
            const matches = batchOrderMatchesTokenData(
              order,
              batchRowTokenData(row, row.idempotency_key),
              batchPickupTokenData(pickup, service, defaultContents),
            );
            const editable = (
              order.status === 'paid'
              && order.payment_status === 'wallet_reserved'
              && order.reservation_status === 'reserved'
            );
            row.existing_order = {
              id: order.id,
              status: order.status,
              price: Number(order.price || 0),
              editable,
            };
            row.import_action = matches ? 'unchanged' : (editable ? 'update' : 'locked');
            if (!matches && !editable) row.errors.push('existing_order_locked');
          }
        }
        if (!pickup.errors.length) {
          const smartMapping = smartImport?.mapping_source === 'workers_ai'
            ? {
                mapping_signature: smartImport.mapping_signature,
                mappings: smartImport.mappings.map((mapping) => ({
                  field: mapping.field,
                  column_index: mapping.column_index,
                  confidence: mapping.confidence,
                })),
              }
            : null;
          pickup.batch_token = await signBusinessBatchToken(
            env,
            session.account_id,
            'pickup',
            batchPickupTokenData(pickup, service, defaultContents, smartMapping),
            { approved: pickup.corrections.length === 0 },
          );
        }
        return json({
          rows,
          pickup,
          row_count: rows.length,
          valid_count: rows.filter((row) => row.errors.length === 0).length,
          import_mode: normalizedBatch.import_mode,
          ...(smartImport ? {
            smart_import: {
              model: smartImport.model,
              mapping_source: smartImport.mapping_source,
              row_normalization: smartImport.row_normalization,
              sheet_index: smartImport.sheet_index,
              header_row_number: smartImport.header_row_number,
              mappings: smartImport.mappings,
            },
          } : {}),
        });
      } catch (error) {
        const status = error?.message === 'payload_too_large'
          ? 413
          : ['smart_import_unavailable', 'smart_import_invalid'].includes(error?.message)
            ? 503
            : 400;
        return json({
          error: error && error.message ? error.message : 'invalid_batch',
          ...(Array.isArray(error && error.missing) ? { missing: error.missing } : {}),
        }, status);
      }
    }

    if (path === '/api/business/batches/approve' && req.method === 'POST') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await readJson(req, 256 * 1024); } catch (error) {
        return json({ error: error.message }, error.status || 400);
      }
      const rowTokens = Array.isArray(body.row_tokens) ? body.row_tokens : [];
      if (!rowTokens.length || rowTokens.length > 100 || !body.pickup_token) {
        return json({ error: 'invalid_batch_approval' }, 400);
      }
      try {
        const pickupPayload = await verifyBusinessBatchToken(
          env,
          session.account_id,
          body.pickup_token,
          { kind: 'pickup' },
        );
        const approvedRows = await Promise.all(rowTokens.map((token) => (
          approveBusinessBatchToken(env, session.account_id, token, 'row')
        )));
        const approvedPickup = await approveBusinessBatchToken(
          env,
          session.account_id,
          body.pickup_token,
          'pickup',
        );
        let mappingSaved = false;
        if (pickupPayload.data?.smart_mapping) {
          try {
            await saveBusinessBatchMapping(
              env.DB,
              session.account_id,
              pickupPayload.data.smart_mapping,
            );
            mappingSaved = true;
          } catch (error) {
            console.error(
              'business_batch_mapping_save_failed',
              error && error.message ? error.message : String(error),
            );
          }
        }
        return json({
          row_tokens: approvedRows,
          pickup_token: approvedPickup,
          mapping_saved: mappingSaved,
        });
      } catch (error) {
        return json({ error: error.message || 'invalid_batch_approval' }, 400);
      }
    }

    const businessOrderMatch = path.match(/^\/api\/business\/orders\/(\d+)$/);
    if (businessOrderMatch && req.method === 'DELETE') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      const orderId = Number(businessOrderMatch[1]);
      if (!Number.isSafeInteger(orderId) || orderId <= 0) {
        return json({ error: 'invalid_order_id' }, 400);
      }
      const cancelled = await cancelReservedBusinessOrder(env.DB, session.account_id, orderId);
      if (!cancelled.cancelled) {
        const status = cancelled.error === 'order_not_found' ? 404 : 409;
        return json({ error: cancelled.error }, status);
      }
      return json({
        ok: true,
        order_id: orderId,
        released: Number(cancelled.released_agorot || 0) / 100,
      });
    }

    if (path === '/api/business/topups' && req.method === 'POST') {
      const session = await getBusinessSession(req, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400); }
      const selectedPlan = publicBusinessPlans().find((plan) => plan.id === b.plan_id);
      if (!selectedPlan) return json({ error: 'invalid_plan' }, 400);
      const couponAccountKey = businessCouponCustomerKey(session);
      let coupon = null;
      if (b.coupon_code) {
        const v = await validateCoupon(env.DB, b.coupon_code, selectedPlan.amount, couponAccountKey, { scope: 'business_plan', planId: selectedPlan.id });
        if (!v.valid) return json({ valid: false, error: 'invalid_coupon', reason: v.reason, message: couponMessage(v.reason) }, 400);
        coupon = v;
      }
      const topup = await createWalletTopup(env.DB, session, b.plan_id, coupon);
      if (!topup) return json({ error: 'invalid_plan' }, 400);
      if (topup.error) return json({ error: topup.error }, topup.error === 'trial_already_used' ? 409 : 503);
      let redemptionRecorded = false;
      if (coupon) {
        try {
          const redemption = await recordBusinessRedemption(env.DB, {
            topupId: topup.id,
            code: coupon.code,
            customerKey: couponAccountKey,
            priceBefore: coupon.subtotal,
            discountAmount: coupon.discountAmount,
            priceAfter: coupon.price,
            usageLimit: coupon.usageLimit,
            oncePerCustomer: coupon.appliesOncePerCustomer,
          });
          if (!redemption.recorded) {
            await cancelWalletTopup(env.DB, topup.id);
            const reason = coupon.usageLimit != null ? 'usage_limit_reached' : 'already_used';
            return json({ valid: false, error: 'invalid_coupon', reason, message: couponMessage(reason) }, 400);
          }
          redemptionRecorded = true;
        } catch (error) {
          await cancelWalletTopup(env.DB, topup.id).catch(() => {});
          console.error('business_coupon_redemption_failed', error && error.message || String(error));
          return json({ error: 'coupon_unavailable' }, 503);
        }
      }
      try {
        const charge = await createWalletCharge(env, {
          id: topup.id,
          plan_id: topup.plan.id,
          plan_name_he: topup.plan.name_he,
          email: topup.email,
          company_name: topup.company_name,
          subtotal: topup.subtotal,
          credit_amount: topup.credit_amount,
          discount_code: topup.discount_code,
          discount_amount: topup.discount_amount,
          discount_title: topup.discount_title,
        }, topup.amount);
        if (!charge || !charge.checkoutUrl) throw new Error('checkout_unavailable');
        await markWalletTopupCheckout(env.DB, topup.id, charge);
        return json({
          ok: true,
          topup_id: topup.id,
          checkout_url: charge.checkoutUrl,
          subtotal_price: topup.subtotal,
          discount_code: topup.discount_code,
          discount_amount: topup.discount_amount,
          price: topup.amount,
          credit_amount: topup.credit_amount,
        });
      } catch (error) {
        if (redemptionRecorded) await releaseBusinessRedemption(env.DB, topup.id).catch(() => {});
        await cancelWalletTopup(env.DB, topup.id).catch(() => {});
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
    // Privacy-safe browser bridge for a paid-order analytics event. The credential
    // is random, short-lived, sent only in the POST body, and stored only as a hash.
    // A clean payment return may observe it once; no order/customer identifier is
    // returned to the browser or analytics container.
    if (path === '/api/analytics/paid-conversion' && req.method === 'POST') {
      try {
        const key = await anonKey(env, clientIp(req));
        const limit = await incrRateLimit(env.DB, 'aconv:' + key, 60 * 1000);
        if (limit.count > 40) {
          return json(
            { error: 'rate_limited' },
            429,
            { ...cors, 'Retry-After': '60' },
          );
        }
      } catch (error) {
        console.error(
          'rate_limit_error',
          error && error.message ? error.message : String(error),
        );
      }
      let body;
      try { body = await readJson(req, 1024); } catch (error) {
        return json({ error: error.message }, error.status || 400, cors);
      }
      const result = await observeAnalyticsClaim(
        env.DB,
        body.credential,
        body.eligible === true,
      );
      if (result.status === 'emitted') {
        return json({
          event: result.event,
          value: result.value,
          currency: result.currency,
        }, 200, cors);
      }
      if (result.status === 'pending') return json({ status: 'pending' }, 202, cors);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...cors } });
    }

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
      const businessSession = b.use_wallet ? await getBusinessSession(req, env) : null;
      let pr = await authoritativeQuote(env, b);
      if (businessSession && businessSession.plan_id) pr = applyBusinessPlanPricing(pr, businessSession.plan_id);
      const v = await validateCoupon(env.DB, b.coupon_code, pr.price, couponIdentity(b, businessSession));
      if (!v.valid) return json({ valid: false, reason: v.reason, message: couponMessage(v.reason) }, 200, cors);
      return json({ valid: true, code: v.code, subtotal_price: v.subtotal, discount_amount: v.discountAmount, price: v.price, title: v.title }, 200, cors);
    }

    // Automatic promotion preview. This endpoint never reserves eligibility;
    // POST /api/orders recomputes the price, rechecks the identity, and performs
    // the atomic claim before any order or wallet mutation.
    if (path === '/api/coupons/auto-apply' && req.method === 'POST') {
      try {
        const k = await anonKey(env, clientIp(req));
        const rl = await incrRateLimit(env.DB, 'cpna:' + k, 60 * 1000);
        if (rl.count > 20) return json({ applied: false }, 429, { ...cors, 'Retry-After': '60' });
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }
      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400, cors); }
      const businessSession = b.use_wallet ? await getBusinessSession(req, env) : null;
      if (b.use_wallet && !businessSession) return json({ applied: false }, 200, cors);
      let pr = await authoritativeQuote(env, b);
      if (businessSession) {
        if (!businessSession.plan_id) return json({ applied: false }, 200, cors);
        pr = applyBusinessPlanPricing(pr, businessSession.plan_id);
      }
      const promotion = await findAutomaticCoupon(env.DB, pr.price, couponIdentity(b, businessSession));
      if (!promotion.valid) return json({ applied: false }, 200, cors);
      return json({
        applied: true,
        valid: true,
        automatic: true,
        subtotal_price: promotion.subtotal,
        discount_amount: promotion.discountAmount,
        price: promotion.price,
        title: promotion.title,
      }, 200, cors);
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
      // Business batches can legitimately create up to 100 delivery orders. A
      // validated account session gets an account-scoped ceiling while public
      // requests retain the much tighter anti-abuse limits.
      const preAuthenticatedBusinessSession = await getBusinessSession(req, env);
      try {
        const isBusiness = !!preAuthenticatedBusinessSession;
        const k = isBusiness
          ? `business:${preAuthenticatedBusinessSession.account_id}`
          : await anonKey(env, clientIp(req));
        const r10 = await incrRateLimit(env.DB, (isBusiness ? 'ordbiz:' : 'ord:') + k, 10 * 60 * 1000);
        if (r10.count > (isBusiness ? 200 : 5)) { console.log('order_rate_limited', { window: '10m', business: isBusiness }); return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '600' }); }
        const rd = await incrRateLimit(env.DB, (isBusiness ? 'ordbizd:' : 'ordd:') + k, 24 * 60 * 60 * 1000);
        if (rd.count > (isBusiness ? 500 : 20)) { console.log('order_rate_limited', { window: 'day', business: isBusiness }); return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '86400' }); }
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }

      let b; try { b = await readJson(req); } catch (e) { return json({ error: e.message }, e.status || 400, cors); }
      const businessSession = b.use_wallet ? preAuthenticatedBusinessSession : null;
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
      const phoneDeliveryLinkOptIn = b.phone_delivery_link_opt_in === true;
      b = {
        ...b,
        phone,
        phone_delivery_link_opt_in: phoneDeliveryLinkOptIn,
        phone_delivery_link_opt_in_at: phoneDeliveryLinkOptIn ? Date.now() : null,
      };

      let batchRowApproval = null;
      let batchPickupApproval = null;
      if (b.batch_row_token || b.batch_pickup_token) {
        if (!businessSession || !b.batch_row_token || !b.batch_pickup_token) {
          return json({ error: 'invalid_batch_approval' }, 400, cors);
        }
        try {
          [batchRowApproval, batchPickupApproval] = await Promise.all([
            verifyBusinessBatchToken(
              env,
              businessSession.account_id,
              b.batch_row_token,
              { kind: 'row', requireApproved: true },
            ),
            verifyBusinessBatchToken(
              env,
              businessSession.account_id,
              b.batch_pickup_token,
              { kind: 'pickup', requireApproved: true },
            ),
          ]);
        } catch (error) {
          return json({ error: error.message || 'invalid_batch_approval' }, 400, cors);
        }
        if (!batchOrderMatchesTokenData(b, batchRowApproval.data, batchPickupApproval.data)) {
          return json({ error: 'batch_payload_mismatch' }, 409, cors);
        }
      }

      const walletIdempotencyKey = businessSession
        ? (req.headers.get('Idempotency-Key') || b.idempotency_key)
        : null;
      if (businessSession && !walletIdempotencyKey) {
        return json({ error: 'idempotency_key_required' }, 400, cors);
      }
      if (
        batchRowApproval
        && walletIdempotencyKey !== batchRowApproval.data.idempotency_key
      ) {
        return json({ error: 'batch_idempotency_mismatch' }, 409, cors);
      }
      let existingWalletOrder = null;
      if (businessSession) {
        existingWalletOrder = await env.DB.prepare(
          `SELECT o.*, wr.status AS reservation_status,
             wr.amount_agorot AS reserved_amount_agorot
           FROM wallet_reservations wr
           JOIN orders o ON o.id = wr.order_id
           WHERE wr.account_id = ? AND wr.idempotency_key = ?
           LIMIT 1`
        ).bind(businessSession.account_id, walletIdempotencyKey).first();
        const existingMatches = existingWalletOrder && batchRowApproval
          ? batchOrderMatchesTokenData(
            existingWalletOrder,
            batchRowApproval.data,
            batchPickupApproval.data,
          )
          : true;
        if (existingWalletOrder && existingMatches) {
          return json({
            order_id: existingWalletOrder.id,
            token: existingWalletOrder.token,
            tracking_url: trackingUrl(env, existingWalletOrder.token),
            status: existingWalletOrder.status,
            price: existingWalletOrder.price,
            wallet: true,
            idempotent: true,
          }, 200, cors);
        }
      }

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
        const v = await validateCoupon(env.DB, b.coupon_code, pr.price, couponIdentity(b, businessSession));
        if (!v.valid) return json({ valid: false, error: 'invalid_coupon', reason: v.reason, message: couponMessage(v.reason) }, 400, cors);
        coupon = v;
      } else {
        const automatic = await findAutomaticCoupon(
          env.DB,
          pr.price,
          couponIdentity(b, businessSession),
          { idempotencyKey: walletIdempotencyKey }
        );
        if (automatic.valid) coupon = automatic;
      }
      if (!b.coupon_code && b.promotion_expected === true && !coupon) {
        return json({
          valid: false,
          error: 'invalid_coupon',
          reason: 'not_new_customer',
          message: couponMessage('not_new_customer'),
        }, 409, cors);
      }

      let promotionClaim = null;
      let promotionClaimCreated = false;
      if (coupon && coupon.eligibilityRule === 'first_delivery') {
        try {
          const claimResult = await reserveFirstDeliveryClaim(env.DB, {
            coupon,
            identity: couponIdentity(b, businessSession),
            idempotencyKey: walletIdempotencyKey,
          });
          if (!claimResult.reserved) {
            const reason = claimResult.reason || 'not_new_customer';
            return json({ valid: false, error: 'invalid_coupon', reason, message: couponMessage(reason) }, 409, cors);
          }
          promotionClaim = claimResult.claim;
          promotionClaimCreated = !claimResult.unchanged;
        } catch (error) {
          console.error('promotion_claim_failed', error && error.message || String(error));
          return json({
            valid: false,
            error: 'invalid_coupon',
            reason: 'promotion_unavailable',
            message: couponMessage('promotion_unavailable'),
          }, 503, cors);
        }
      }
      // `price` on the order row is always the amount the customer pays; when a coupon
      // applied, subtotal_price/discount_* record how we got there (migration 008).
      const finalPrice = coupon ? coupon.price : pr.price;
      // The reviewed batch quote is a customer-approved ceiling. Fail closed if
      // the authoritative charge increased, but allow a newly applicable
      // automatic discount to lower the actual wallet reservation.
      const approvedBatchPrice = Number(b.expected_price);
      if (
        batchRowApproval
        && b.expected_price != null
        && (
          !Number.isFinite(approvedBatchPrice)
          || Number(finalPrice) > approvedBatchPrice
        )
      ) {
        if (promotionClaimCreated) {
          await releaseFirstDeliveryClaim(
            env.DB,
            promotionClaim && promotionClaim.id,
          ).catch(() => {});
        }
        return json({
          error: 'batch_quote_changed',
          expected: approvedBatchPrice,
          current: Number(finalPrice),
        }, 409, cors);
      }
      const discountFields = {
        subtotal_price: coupon ? coupon.subtotal : null,
        discount_code: coupon ? coupon.code : null,
        discount_amount: coupon ? coupon.discountAmount : 0,
        discount_title: coupon ? coupon.title : null,
      };

      if (existingWalletOrder && batchRowApproval) {
        const batchTokenSignature = String(b.batch_row_token).split('.').pop().slice(0, 32);
        const update = await updateReservedBusinessOrder(env.DB, {
          accountId: businessSession.account_id,
          orderId: existingWalletOrder.id,
          reservationId: existingWalletOrder.wallet_reservation_id,
          amountAgorot: Math.round(finalPrice * 100),
          adjustmentKey: `batch-update:${batchTokenSignature}`,
          order: {
            ...b,
            price: finalPrice,
            business_external_id: batchRowApproval.data.external_id,
          },
        });
        if (!update.updated) {
          if (update.error === 'insufficient_credit') {
            return json({
              error: 'insufficient_credit',
              available: Number(update.available_agorot || 0) / 100,
              shortfall: Number(update.shortfall_agorot || 0) / 100,
            }, 402, cors);
          }
          return json({ error: update.error || 'existing_order_locked' }, 409, cors);
        }
        return json({
          order_id: existingWalletOrder.id,
          token: existingWalletOrder.token,
          tracking_url: trackingUrl(env, existingWalletOrder.token),
          status: 'paid',
          price: finalPrice,
          previous_price: Number(update.previous_amount_agorot || 0) / 100,
          credit_delta: Number(update.amount_agorot - update.previous_amount_agorot) / 100,
          wallet: true,
          updated: true,
        }, 200, cors);
      }

      let walletReservation = null;
      let walletReservationCreated = false;
      if (businessSession) {
        let reservationResult;
        try {
          reservationResult = await reserveWalletCredit(
            env.DB,
            businessSession.account_id,
            Math.round(finalPrice * 100),
            walletIdempotencyKey
          );
        } catch (error) {
          if (promotionClaimCreated) await releaseFirstDeliveryClaim(env.DB, promotionClaim && promotionClaim.id).catch(() => {});
          throw error;
        }
        if (!reservationResult.reserved) {
          if (promotionClaimCreated) await releaseFirstDeliveryClaim(env.DB, promotionClaim && promotionClaim.id).catch(() => {});
          return json({
            error: 'insufficient_credit',
            available: Number(reservationResult.available_agorot || 0) / 100,
            shortfall: Number(reservationResult.shortfall_agorot || 0) / 100,
          }, 402, cors);
        }
        walletReservation = reservationResult.reservation;
        walletReservationCreated = !reservationResult.unchanged;
        if (walletReservation && walletReservation.order_id) {
          const existingOrder = await getOrderById(env.DB, walletReservation.order_id);
          if (existingOrder) {
            if (promotionClaim) await attachFirstDeliveryClaim(env.DB, promotionClaim.id, existingOrder.id).catch(() => {});
            return json({ order_id: existingOrder.id, token: existingOrder.token, tracking_url: trackingUrl(env, existingOrder.token), status: existingOrder.status, price: existingOrder.price, wallet: true, idempotent: true }, 200, cors);
          }
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
          business_external_id: batchRowApproval ? batchRowApproval.data.external_id : null,
          wallet_reservation_id: walletReservation ? walletReservation.id : null,
          payment_method: businessSession ? 'wallet' : null,
          email_verified: businessSession ? 1 : 0,
          ...discountFields
        });
      } catch (error) {
        if (walletReservation) {
          // The unique wallet_reservation_id index serializes concurrent retries.
          // If another request already created the order, return that winner and
          // heal the reservation's reverse link instead of releasing its funds.
          let existingOrder = null;
          let existingOrderLookupSucceeded = false;
          try {
            existingOrder = await getOrderByWalletReservationId(env.DB, walletReservation.id);
            existingOrderLookupSucceeded = true;
          } catch {
            // A lookup failure is ambiguous: the INSERT may already have committed.
            // Keep the reservation held so a later retry can heal the reverse link.
          }
          if (existingOrder) {
            await linkWalletReservationToOrder(env.DB, walletReservation.id, existingOrder.id);
            if (promotionClaim) await attachFirstDeliveryClaim(env.DB, promotionClaim.id, existingOrder.id).catch(() => {});
            return json({
              order_id: existingOrder.id,
              token: existingOrder.token,
              tracking_url: trackingUrl(env, existingOrder.token),
              status: existingOrder.status,
              price: existingOrder.price,
              wallet: true,
              idempotent: true,
            }, 200, cors);
          }
          // Only the request that created an otherwise-unused reservation may
          // release it. A retry must never release another request's hold.
          if (walletReservationCreated && existingOrderLookupSucceeded) {
            await releaseWalletReservation(env.DB, walletReservation.id).catch(() => {});
          }
        }
        if (promotionClaimCreated && (!businessSession || walletReservationCreated)) {
          await releaseFirstDeliveryClaim(env.DB, promotionClaim && promotionClaim.id).catch(() => {});
        }
        throw error;
      }
      const token = created.token;
      const finalUrl = trackingUrl(env, token);
      if (walletReservation) {
        await linkWalletReservationToOrder(env.DB, walletReservation.id, created.id);
        await env.DB.prepare(`UPDATE orders SET email = ?, email_verified = 1, payment_mode = 'wallet' WHERE id = ?`).bind(b.email, created.id).run();
      }
      if (promotionClaim) {
        try {
          await attachFirstDeliveryClaim(env.DB, promotionClaim.id, created.id);
        } catch (error) {
          // The claim itself already blocks a second use. Keep the accepted order
          // and log only a sanitized operational signal.
          console.error('promotion_claim_attach_failed');
        }
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
          redemption = await recordRedemption(env.DB, {
            orderId: created.id,
            code: coupon.code,
            customerKey: couponIdentity(b, businessSession).customerKey,
            priceBefore: coupon.subtotal,
            discountAmount: coupon.discountAmount,
            priceAfter: coupon.price,
            usageLimit: coupon.usageLimit,
            oncePerCustomer: coupon.appliesOncePerCustomer,
            promotionClaimId: promotionClaim && promotionClaim.id,
          });
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

      const testMode = (env.TEST_MODE === '1' || env.TEST_MODE === 'true')
        && url.searchParams.get('test') === '1';
      let analyticsClaimRegistered = false;
      if (!businessSession && !isReview && !testMode && b.analytics_context) {
        try {
          analyticsClaimRegistered = await registerAnalyticsClaim(
            env.DB,
            created.id,
            b.analytics_context,
          );
        } catch {
          // Analytics is optional and must never block an accepted delivery order.
          console.error('analytics_claim_registration_failed');
        }
      }

      // Set OTP hash to gate the tracking page, but DON'T email the code yet.
      // The code is regenerated and emailed AFTER payment is confirmed (webhook handler).
      if (b.email && !businessSession) {
        const otp = genOtp();
        await setEmailAndOtp(env.DB, created.id, b.email, await hashOtp(env, otp), Date.now() + 2 * 60 * 60 * 1000);
      }

      // Public orders still need Eden's payment/review notice. Wallet-backed
      // business orders are already accepted and get their own operations notice
      // below, so they must not be mislabeled as "awaiting payment".
      if (!businessSession) {
        try {
          await notifyEmail(env, env.DB, { orderId: created.id, template: 'ops_new_order', recipient: env.OPS_EMAIL, subject: `הזמנה חדשה #${created.id}${isReview ? ' — לבדיקה' : ' — ממתינה לתשלום'}`, html: `${escHtml(b.name)} · ${escHtml(b.pickup)} → ${escHtml(b.dropoff)} · ₪${escHtml(finalPrice)}${coupon ? ` (קופון ${escHtml(coupon.code)} — הנחה ₪${escHtml(coupon.discountAmount)})` : ''}${isReview ? '<br>חריג: ' + escHtml(pr.reasons.join(',')) : ''}<br><a href="${escHtml(finalUrl)}">${escHtml(finalUrl)}</a>` });
        } catch {}
      }

      // Review orders: tell the customer what happens next (Eden confirms the price,
      // then a payment link arrives by email). Without this they heard nothing at all
      // until after payment — most would assume the order vanished.
      if (isReview && b.email) {
        try { await notifyEmail(env, env.DB, { orderId: created.id, template: 'customer_request_received', recipient: b.email, subject: `קיבלנו את הבקשה ✓ — הזמנה #${created.id} ב-EdenMish`, html: requestReceivedHtml(env, { ...b, id: created.id, price: finalPrice, price_is_estimate: true }) }); } catch {}
      }

      if (businessSession) {
        try {
          await notifyEmail(env, env.DB, {
            orderId: created.id,
            template: 'customer_business_order_confirmation',
            recipient: b.email,
            subject: `המשלוח העסקי נוצר ✓ — מעקב משלוח #${created.id}`,
            html: businessOrderConfirmedHtml(
              env,
              { ...created, ...b, price: finalPrice, ...discountFields },
              finalUrl,
            ),
          });
        } catch {}
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
        review: isReview,
        reasons: pr.reasons,
        analytics_claim: analyticsClaimRegistered,
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
      // viewing while the delivery is active. After the 24-hour post-delivery
      // privacy window, durable email ownership is not enough: a fresh OTP must
      // mint a short-lived, order-scoped unlock cookie.
      const privacyLocked = trackingPrivacyIsLocked(o);
      const privacyUnlocked = privacyLocked && await checkTrackingUnlock(
        env,
        getCookie(req, TRACKING_UNLOCK_COOKIE),
        o.id,
        o.token,
      );
      if (privacyLocked && !privacyUnlocked) {
        return json({ order: publicOrderSummary(o), history: [], gps: null, otp_pending: true }, 200, cors);
      }
      const proofP = o.status === 'delivered' ? getDeliveryProof(env.DB, o.id) : Promise.resolve(null);
      const trailP = getGpsTrail(env.DB, o.id);
      const redeliveryP = redeliveryPublicState(env.DB, o);
      const [history, gps, proof, trail, redelivery] = await Promise.all([
        getStatusHistory(env.DB, o.id),
        latestGps(env.DB, o.id),
        proofP,
        trailP,
        redeliveryP,
      ]);
      delete o.otp_hash;
      delete o.pending_redelivery_json;
      return json({
        order: o,
        history: history.results,
        gps,
        proof,
        gpsTrail: trail,
        redelivery,
        otp_pending: false,
      }, 200, cors);
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
        if (!trackingPrivacyIsLocked(o)) {
          return json({ verified: true }, 200, cors);
        }
        const unlock = await makeTrackingUnlock(env, o.id, o.token);
        return json(
          { verified: true },
          200,
          { ...cors, 'Set-Cookie': trackingUnlockCookie(unlock) },
        );
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
      if (!o || !o.email || !trackingIsAvailable(o)) return json({ ok: true }, 200, cors);
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

    // ---- redelivery: owner supplies a corrected address for a held package ----
    // The tracking token identifies the order and email OTP authorizes this sensitive write.
    // Only valid while the package is held for redelivery; it stages the address and returns
    // the fee, and deliberately does NOT dispatch — verified payment is a separate gate.
    if (path.startsWith('/api/orders/') && path.endsWith('/redelivery-address') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o) return json({ ok: false, error: 'not_found' }, 404, cors);
      if (!(o.status === 'failed' && o.retained_by_driver === 'hold_for_redelivery')) {
        return json({ ok: false, error: 'not_awaiting_redelivery' }, 409, cors);
      }
      const existingCharge = await getRedeliveryChargeByOrderId(env.DB, o.id);
      if (existingCharge) {
        return json({ ok: false, error: 'address_locked_after_payment_started' }, 409, cors);
      }
      // Changing a delivery address is a sensitive write. The magic-link token grants read-only
      // tracking; a write must clear the same OTP bar the tracking model reserves for
      // address/phone changes, so a leaked link alone cannot reroute someone's package. The
      // owner verifies once via /verify-otp (a code to the email on file), which sets
      // email_verified; the client runs that flow before enabling the address form.
      if (!o.email_verified) return json({ ok: false, error: 'otp_required' }, 403, cors);
      let b; try { b = await req.json(); } catch { b = {}; }
      const dropoff = String(b.dropoff || '').trim().slice(0, 500);
      const dropoffDetail = b.dropoff_detail != null ? String(b.dropoff_detail).trim().slice(0, 500) : null;
      const dropoffCity = String(b.dropoff_city || '').trim().slice(0, 100);
      const lat = b.dropoff_lat;
      const lng = b.dropoff_lng;
      if (!dropoff || !dropoffCity) return json({ ok: false, error: 'missing_address' }, 400, cors);
      // A redelivery must be routable, so coordinates are required here (unlike booking, which
      // allows a human review pass). A pin the driver cannot navigate to is useless.
      if (!validCoordinate(lat, -90, 90) || !validCoordinate(lng, -180, 180)) {
        return json({ ok: false, error: 'invalid_coordinates' }, 400, cors);
      }
      // The corrected destination itself must be inside a served zone. retryFee prices by the
      // max of the two ends, so it would happily quote a Zone 1 fee for an unserved destination
      // just because the pickup is in Zone 1 — serviceability has to gate on the destination.
      if (zoneOf(dropoffCity) == null) return json({ ok: false, error: 'out_of_zone' }, 400, cors);
      const suggestion = retryFee({
        pickup_city: o.pickup_city,
        dropoff_city: dropoffCity,
        when_date: o.when_date,
        when_hour: o.when_hour,
      });
      if (suggestion.fee == null) return json({ ok: false, error: 'out_of_zone' }, 400, cors);
      const pending = {
        dropoff,
        dropoff_detail: dropoffDetail,
        dropoff_lat: lat,
        dropoff_lng: lng,
        dropoff_city: dropoffCity,
        zone: suggestion.zone,
        fee: suggestion.fee,
        submitted_at: Date.now(),
      };
      const staged = await env.DB.prepare(`UPDATE orders
        SET pending_redelivery_json = ?
        WHERE id = ?
          AND status = 'failed'
          AND retained_by_driver = 'hold_for_redelivery'
          AND NOT EXISTS (
            SELECT 1 FROM redelivery_charges
            WHERE order_id = orders.id
          )`)
        .bind(JSON.stringify(pending), o.id).run();
      if (!staged?.meta?.changes) {
        return json({ ok: false, error: 'address_locked_after_payment_started' }, 409, cors);
      }
      console.log('redelivery_address_staged', { order: o.id, zone: suggestion.zone, fee: suggestion.fee });
      return json({ ok: true, fee: suggestion.fee, zone: suggestion.zone, currency: 'ILS' }, 200, cors);
    }

    // ---- redelivery: create or resume the purpose-specific Shopify checkout ----
    // The fee comes only from the server-staged address. It never mutates the
    // original delivery's price/payment columns and cannot release dispatch.
    if (path.startsWith('/api/orders/') && path.endsWith('/redelivery-payment') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o) return json({ ok: false, error: 'not_found' }, 404, cors);
      if (!(o.status === 'failed' && o.retained_by_driver === 'hold_for_redelivery')) {
        return json({ ok: false, error: 'not_awaiting_redelivery' }, 409, cors);
      }
      let pending = null;
      try { pending = o.pending_redelivery_json ? JSON.parse(o.pending_redelivery_json) : null; } catch {}
      const amountNis = Number(pending?.fee);
      if (!pending || !Number.isFinite(amountNis) || amountNis <= 0) {
        return json({ ok: false, error: 'no_pending_address' }, 409, cors);
      }
      const now = Date.now();
      const expiresAt = Number(o.retained_at || now) + 24 * 60 * 60 * 1000;
      if (expiresAt <= now) return json({ ok: false, error: 'redelivery_window_expired' }, 409, cors);

      let charge = await getRedeliveryChargeByOrderId(env.DB, o.id);
      if (charge && charge.address_snapshot_json !== o.pending_redelivery_json) {
        return json({ ok: false, error: 'redelivery_address_changed' }, 409, cors);
      }
      if (charge?.status === 'link_sent' && charge.payment_url) {
        return json({
          ok: true,
          payment_url: charge.payment_url,
          fee: Number(charge.amount_agorot) / 100,
          currency: charge.currency,
          idempotent: true,
        }, 200, cors);
      }
      if (charge?.status === 'paid' || charge?.status === 'released') {
        return json({ ok: true, paid: true, fee: Number(charge.amount_agorot) / 100 }, 200, cors);
      }
      if (charge && !['pending', 'creating'].includes(charge.status)) {
        return json({ ok: false, error: 'redelivery_payment_unavailable' }, 409, cors);
      }
      if (!charge) {
        charge = await createRedeliveryCharge(env.DB, {
          id: `rdl_${crypto.randomUUID()}`,
          orderId: o.id,
          amountAgorot: Math.round(amountNis * 100),
          addressSnapshotJson: o.pending_redelivery_json,
          now,
          expiresAt,
        });
        if (!charge) {
          return json({ ok: false, error: 'redelivery_address_changed' }, 409, cors);
        }
      }
      const claimed = await env.DB.prepare(`UPDATE redelivery_charges
        SET status = 'creating', updated_at = ?
        WHERE id = ? AND (
          status = 'pending'
          OR (status = 'creating' AND updated_at < ?)
        )`).bind(now, charge.id, now - 2 * 60 * 1000).run();
      if (!claimed?.meta?.changes) {
        const current = await getRedeliveryChargeById(env.DB, charge.id);
        if (current?.status === 'link_sent' && current.payment_url) {
          return json({
            ok: true,
            payment_url: current.payment_url,
            fee: Number(current.amount_agorot) / 100,
            currency: current.currency,
            idempotent: true,
          }, 200, cors);
        }
        return json({ ok: false, error: 'redelivery_payment_in_progress' }, 409, cors);
      }
      const chargeResult = await createCharge(env, {
        ...o,
        redelivery_dropoff: pending.dropoff,
      }, amountNis, {
        purpose: 'redelivery',
        reference: charge.id,
      });
      if (!chargeResult) {
        await env.DB.prepare(`UPDATE redelivery_charges
          SET status = 'pending', updated_at = ?
          WHERE id = ? AND status = 'creating'`)
          .bind(Date.now(), charge.id).run();
        return json({ ok: false, error: 'payment_provider_unavailable' }, 503, cors);
      }
      await env.DB.prepare(`UPDATE redelivery_charges
        SET status = 'link_sent', payment_url = ?, processor_ref = ?,
            shopify_draft_order_id = ?, updated_at = ?
        WHERE id = ? AND status = 'creating'`)
        .bind(
          chargeResult.checkoutUrl,
          chargeResult.processorRef,
          chargeResult.draftOrderId,
          now,
          charge.id,
        ).run();
      await recordPayment(env.DB, o.id, {
        amount: Math.round(amountNis * 100),
        status: 'redelivery_link_sent',
        url: chargeResult.checkoutUrl,
      });
      return json({
        ok: true,
        payment_url: chargeResult.checkoutUrl,
        fee: amountNis,
        currency: 'ILS',
      }, 201, cors);
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

    if (onOps && path === '/api/ops/driver/invitations' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const [drivers, invitations] = await Promise.all([
        listActiveDrivers(env.DB),
        listDriverInvitations(env.DB),
      ]);
      return json({ drivers, invitations });
    }

    if (onOps && path === '/api/ops/driver/invitations' && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      if (!isTrustedOpsMutationOrigin(req, env)) return json({ error: 'untrusted_origin' }, 403);
      let b; try { b = await readJson(req); } catch (error) {
        return json({ error: error.message }, error.status || 400);
      }
      const result = await createDriverInvitation(env, {
        driverId: b.driver_id,
        expiresInMinutes: b.expires_in_minutes,
      });
      if (!result.ok) return json({ error: result.error }, result.status);
      console.log('driver_invitation_created', {
        invitation_id: result.invitation.invitation_id,
        driver_id: result.invitation.driver_id,
        expires_at: result.invitation.expires_at,
      });
      return json({ ok: true, invitation: result.invitation }, result.status);
    }

    const driverInvitationRevoke = /^\/api\/ops\/driver\/invitations\/([^/]+)\/revoke$/.exec(path);
    if (onOps && driverInvitationRevoke && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      if (!isTrustedOpsMutationOrigin(req, env)) return json({ error: 'untrusted_origin' }, 403);
      const invitationId = decodeURIComponent(driverInvitationRevoke[1]);
      const result = await revokeDriverInvitation(env.DB, invitationId);
      if (!result.ok) return json({ error: result.error }, result.status);
      console.log('driver_invitation_revoked', { invitation_id: invitationId });
      return json({ ok: true });
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
      const [r, redeliveryRows] = await Promise.all([
        listOrders(env.DB),
        listRedeliveryCharges(env.DB),
      ]);
      const redeliveryByOrder = new Map(
        (redeliveryRows.results || []).map((charge) => [Number(charge.order_id), charge]),
      );
      // Suggest an extra-stop fee for packages a driver is still carrying after a failed
      // delivery, so the operator does not have to work out the zone rate by hand. It is a
      // suggestion only: whether to charge at all is a fault judgement Ops makes.
      const orders = (r.results || []).map((order) => {
        if (!order || !order.retained_by_driver) return order;
        // If the owner has already supplied a corrected redelivery address, surface it and its
        // computed fee. Otherwise suggest the return-to-origin fee as a default.
        let pending = null;
        if (order.pending_redelivery_json) {
          try { pending = JSON.parse(order.pending_redelivery_json); } catch { pending = null; }
        }
        const suggestion = pending || retryFee({
          pickup_city: order.pickup_city,
          // Without a corrected address the leg ends where it was collected (a return).
          dropoff_city: order.pickup_city,
          when_date: order.when_date,
          when_hour: order.when_hour,
        });
        const { pending_redelivery_json, ...rest } = order;
        const redeliveryCharge = redeliveryByOrder.get(Number(order.id));
        return {
          ...rest,
          retry_fee_suggested: suggestion.fee,
          retry_fee_zone: suggestion.zone,
          pending_redelivery: pending && {
            city: pending.dropoff_city,
            dropoff: pending.dropoff,
            fee: pending.fee,
            payment_status: redeliveryCharge?.status || null,
            payment_url: redeliveryCharge?.payment_url || null,
          },
        };
      });
      return json({
        orders,
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
      if (b.status === 'delivered') {
        const completion = await persistOpsDeliveryCompletion(env.DB, before, {
          deliveredAt: fields.delivered_at,
          paymentStatus: fields.payment_status,
        });
        const o = await getOrderById(env.DB, id);
        if (o && completion.transitioned) {
          const { settlement } = await runDeliveryCompletionSideEffects(env, o, {
            notificationsAlreadyEnqueued: true,
            processNotifications: false,
            eventId: completion.eventId,
          });
          ctx?.waitUntil?.(processDeliveryNotificationOutbox(env));
          return json({ ok: true, settlement });
        }
        if (o) return json({ ok: true, unchanged: true });
      } else {
        await setOrderStatus(env.DB, id, b.status, fields);
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
      let completion = null;
      if (!wasDelivered) {
        completion = await persistOpsDeliveryCompletion(env.DB, before, {
          deliveredAt: before.delivered_at || Date.now(),
        });
      }
      const o = await getOrderById(env.DB, id);
      if (!wasDelivered && o && completion?.transitioned) {
        await runDeliveryCompletionSideEffects(env, o, {
          notificationsAlreadyEnqueued: true,
          processNotifications: false,
          eventId: completion?.eventId,
        });
        ctx?.waitUntil?.(processDeliveryNotificationOutbox(env));
      }
      const proof = await getDeliveryProof(env.DB, id);
      return json({ ok: true, order: o, proof });
    }

    // Release a paid redelivery: the signed Shopify webhook has already reconciled the
    // purpose-specific charge. Ops promotes that exact staged address onto the live dropoff
    // columns and flips the hold to the 'redelivery' state that dispatch routes.
    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/release-redelivery') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      const o = await getOrderById(env.DB, id);
      if (!o) return json({ error: 'not found' }, 404);
      if (o.status === 'failed' && o.retained_by_driver === 'redelivery') {
        return json({ ok: true, already: true }); // idempotent re-release
      }
      if (!(o.status === 'failed' && o.retained_by_driver === 'hold_for_redelivery')) {
        return json({ error: 'not_awaiting_redelivery' }, 409);
      }
      let pending = null;
      try { pending = o.pending_redelivery_json ? JSON.parse(o.pending_redelivery_json) : null; } catch { pending = null; }
      if (!pending || pending.dropoff_lat == null || pending.dropoff_lng == null) {
        return json({ error: 'no_pending_address' }, 409);
      }
      const charge = await getRedeliveryChargeByOrderId(env.DB, id);
      if (!charge || charge.status !== 'paid') {
        return json({ error: 'redelivery_payment_required' }, 409);
      }
      if (charge.address_snapshot_json !== o.pending_redelivery_json) {
        return json({ error: 'redelivery_address_changed' }, 409);
      }
      // Overwrite the live destination with the corrected one and mark the order a redelivery.
      // Status stays 'failed' (canonically the first attempt did fail); dispatch routes a fresh
      // drop-off (stop_x…) to the new address on the driver's next route poll.
      const releaseOrder = env.DB.prepare(
        `UPDATE orders SET dropoff = ?, dropoff_detail = ?, dropoff_lat = ?, dropoff_lng = ?,
           dropoff_city = ?, retained_by_driver = 'redelivery', retained_at = ?,
           pending_redelivery_json = NULL
         WHERE id = ? AND status = 'failed' AND retained_by_driver = 'hold_for_redelivery'
           AND EXISTS (
             SELECT 1 FROM redelivery_charges
             WHERE order_id = ? AND status = 'paid'
           )`
      ).bind(
        pending.dropoff, pending.dropoff_detail ?? null, pending.dropoff_lat, pending.dropoff_lng,
        pending.dropoff_city, Date.now(), id, id,
      );
      const releaseCharge = env.DB.prepare(`UPDATE redelivery_charges
        SET status = 'released', released_at = ?, updated_at = ?
        WHERE id = ? AND status = 'paid'
          AND EXISTS (
            SELECT 1 FROM orders
            WHERE id = ? AND retained_by_driver = 'redelivery'
          )`)
        .bind(Date.now(), Date.now(), charge.id, id);
      const released = await env.DB.batch([releaseOrder, releaseCharge]);
      if (!released[0]?.meta?.changes || !released[1]?.meta?.changes) {
        return json({ error: 'redelivery_release_conflict' }, 409);
      }
      console.log('redelivery_released', { order: id, city: pending.dropoff_city, fee: pending.fee });
      return json({ ok: true, order: await getOrderById(env.DB, id) });
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
        if (/^(invalid|first_delivery|automatic coupons)/.test(String(err && err.message || ''))) {
          return json({ error: err.message }, 400);
        }
        throw err;
      }
    }
    if (onOps && path.includes('/api/ops/coupons/') && req.method === 'PUT') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const code = String(path.split('/')[4]).trim().toUpperCase();
      if (!code) return json({ error: 'bad code' }, 400);
      let b; try { b = await req.json(); } catch { b = {}; }
      let c;
      try {
        c = await updateCoupon(env.DB, code, b);
      } catch (err) {
        if (/^(invalid|first_delivery|automatic coupons)/.test(String(err && err.message || ''))) {
          return json({ error: err.message }, 400);
        }
        throw err;
      }
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

    // ---- WhatsApp Cloud API verification and delivery receipts ----
    if (path === '/webhooks/whatsapp' && req.method === 'GET') {
      const challenge = verifyWhatsAppWebhookChallenge(env, url);
      if (challenge == null) return new Response('Forbidden', { status: 403 });
      return new Response(challenge, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (path === '/webhooks/whatsapp' && req.method === 'POST') {
      if (!env.WHATSAPP_APP_SECRET) {
        return json({ error: 'webhook_unconfigured' }, 503);
      }
      const declared = Number(req.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 256 * 1024) {
        return json({ error: 'payload_too_large' }, 413);
      }
      const rawBody = await req.text();
      if (new TextEncoder().encode(rawBody).byteLength > 256 * 1024) {
        return json({ error: 'payload_too_large' }, 413);
      }
      const signature = req.headers.get('X-Hub-Signature-256');
      if (!(await verifyWhatsAppWebhookSignature(
        env.WHATSAPP_APP_SECRET,
        rawBody,
        signature,
      ))) return json({ error: 'invalid signature' }, 401);
      let payload;
      try { payload = JSON.parse(rawBody); } catch {
        return json({ error: 'bad json' }, 400);
      }
      const receipts = extractWhatsAppDeliveryReceipts(payload);
      let matched = 0;
      let updated = 0;
      for (const receipt of receipts) {
        const result = await applyWhatsAppDeliveryReceipt(env.DB, receipt);
        if (result.matched) matched += 1;
        if (result.updated) updated += 1;
      }
      return json({ received: true, matched, updated });
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
        const redeliveryCharge = await getRedeliveryChargeByShopifyOrderId(
          env.DB,
          refund.shopifyOrderId,
        );
        if (redeliveryCharge) {
          await env.DB.batch([
            env.DB.prepare(`UPDATE redelivery_charges
              SET status = 'mismatch', updated_at = ?
              WHERE id = ?`).bind(Date.now(), redeliveryCharge.id),
            env.DB.prepare(`UPDATE orders
              SET review_flag = 1, review_reason = 'redelivery_refund_review'
              WHERE id = ?`).bind(redeliveryCharge.order_id),
          ]);
          return json({ received: true, reconciled: false });
        }
        const o = await getOrderByShopifyOrderId(env.DB, refund.shopifyOrderId);
        if (!o) return json({ received: true, reconciled: false });
        const result = await reconcileShopifyRefund(env, o, refund);
        return json({ received: true, reconciled: !!result.reconciled });
      }

      const parsed = parseShopifyOrderWebhook(b);
      if (parsed.redeliveryChargeId) {
        const charge = await getRedeliveryChargeById(env.DB, parsed.redeliveryChargeId);
        if (!charge) return json({ received: true, reconciled: false });
        const order = await getOrderById(env.DB, charge.order_id);
        if (!order) return json({ received: true, reconciled: false });
        if (parsed.paid && ['paid', 'released', 'late_paid', 'mismatch'].includes(charge.status)) {
          return json({
            received: true,
            reconciled: ['paid', 'released'].includes(charge.status),
          });
        }
        const financialStatus = String(parsed.financial_status || '').toLowerCase();
        if (financialStatus === 'refunded' || financialStatus === 'partially_refunded') {
          await env.DB.batch([
            env.DB.prepare(`UPDATE redelivery_charges
              SET status = 'mismatch', shopify_order_id = ?, updated_at = ?
              WHERE id = ?`).bind(parsed.shopifyOrderId, Date.now(), charge.id),
            env.DB.prepare(`UPDATE orders
              SET review_flag = 1, review_reason = 'redelivery_refund_review'
              WHERE id = ?`).bind(order.id),
          ]);
          return json({ received: true, reconciled: false });
        }
        if (!parsed.paid) return json({ received: true, reconciled: false });

        const paidAmount = Number(parsed.total);
        const expectedAmount = Number(charge.amount_agorot) / 100;
        const amountMatches = Number.isFinite(paidAmount)
          && Math.abs(paidAmount - expectedAmount) < 0.005;
        const currencyMatches = String(parsed.currency || '').toUpperCase()
          === String(charge.currency || 'ILS').toUpperCase();
        const draftMatches = !charge.shopify_draft_order_id || !parsed.draftOrderId
          || String(charge.shopify_draft_order_id) === String(parsed.draftOrderId);
        const now = Date.now();
        if (!amountMatches || !currencyMatches || !draftMatches) {
          await env.DB.batch([
            env.DB.prepare(`UPDATE redelivery_charges
              SET status = 'mismatch', shopify_order_id = ?, updated_at = ?
              WHERE id = ?`).bind(parsed.shopifyOrderId, now, charge.id),
            env.DB.prepare(`UPDATE orders
              SET review_flag = 1, review_reason = 'redelivery_payment_mismatch'
              WHERE id = ?`).bind(order.id),
          ]);
          console.error('redelivery_payment_mismatch', {
            order: order.id,
            charge: charge.id,
            amountMatches,
            currencyMatches,
            draftMatches,
          });
          return json({ received: true, reconciled: false });
        }

        const awaitingRedelivery = order.status === 'failed'
          && order.retained_by_driver === 'hold_for_redelivery'
          && order.pending_redelivery_json
          && Number(charge.expires_at) > now;
        const paidStatus = awaitingRedelivery ? 'paid' : 'late_paid';
        const paidTransition = await env.DB.batch([
          env.DB.prepare(`UPDATE redelivery_charges
            SET status = ?, shopify_order_id = ?, paid_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'creating', 'link_sent', 'expired')`)
            .bind(paidStatus, parsed.shopifyOrderId, now, now, charge.id),
          ...(awaitingRedelivery ? [] : [
            env.DB.prepare(`UPDATE orders
              SET review_flag = 1, review_reason = 'redelivery_payment_after_hold'
              WHERE id = ?`).bind(order.id),
          ]),
        ]);
        if (!paidTransition[0]?.meta?.changes) {
          const current = await getRedeliveryChargeById(env.DB, charge.id);
          return json({
            received: true,
            reconciled: ['paid', 'released'].includes(current?.status),
          });
        }
        await recordPayment(env.DB, order.id, {
          amount: charge.amount_agorot,
          status: paidStatus === 'paid' ? 'redelivery_paid' : 'redelivery_late_paid',
          payplus_id: parsed.shopifyOrderId,
          paid_at: now,
        });
        if (paidStatus === 'paid') {
          if (order.email) {
            try {
              await notifyEmail(env, env.DB, {
                orderId: order.id,
                template: 'customer_redelivery_payment_received',
                recipient: order.email,
                subject: `התשלום למסירה החוזרת התקבל ✓ — הזמנה #${order.id}`,
                html: redeliveryPaidHtml(env, order, expectedAmount),
              });
            } catch {}
          }
          try {
            await notifyEmail(env, env.DB, {
              orderId: order.id,
              template: 'ops_redelivery_payment_received',
              recipient: env.OPS_EMAIL,
              subject: `מסירה חוזרת שולמה #${order.id} — ₪${expectedAmount}`,
              html: `הכתובת המתוקנת והתשלום אומתו. ניתן לשחרר את המסירה החוזרת ב-ops.edenmish.com.`,
            });
          } catch {}
        }
        return json({ received: true, reconciled: paidStatus === 'paid' });
      }
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
        if (shouldHydrateBusinessProfile(credited)) {
          try {
            await hydrateBusinessProfileFromPayment(env.DB, topup.account_id, parsed);
          } catch (error) {
            console.error('business_profile_hydration_failed', { topup: topup.id, account: topup.account_id });
          }
        }
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
              analyticsSettlement: true,
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
  async scheduled(event, env, ctx) {
    // Runs on every scheduled tick, not only the daily one, so a hold reverts to a return
    // close to its 24h boundary rather than up to a day late.
    const tasks = [processDeliveryNotificationOutbox(env), runHeldPackageAutoReturn(env.DB)];
    if (event.cron === '17 2 * * *') {
      tasks.push(
        runRetentionCleanup(env.DB),
        cleanupBusinessSecurity(env.DB),
        cleanupAnalyticsClaims(env.DB),
      );
    }
    ctx.waitUntil(Promise.all(tasks).catch((error) => {
      console.error('scheduled_worker_failed', error && error.message ? error.message : String(error));
    }));
  }
};
