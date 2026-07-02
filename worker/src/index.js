import { createOrder, getOrderByToken, getOrderById, listOrders, setOrderStatus, getStatusHistory, addGps, latestGps, getRules, recordPayment, setEmailAndOtp, verifyOtp, getRateLimit, incrRateLimit, setRateLock, resetRateLimit, getDeliveryProof, upsertDeliveryProof, listRecentNotificationFailures, listNotificationsForOrder } from './db.js';
import { priceOrder } from './pricing.js';
import { makeSession, checkSession, getCookie, genOtp, hashOtp } from './integrations.js';
import { createCharge, settleOrder, verifyShopifyWebhook, parseShopifyOrderWebhook } from './payment.js';
import { trackingHtml, opsHtml } from './pages.js';
import { corsFor, maskEmail, publicOrderSummary, clientIp, anonKey } from './security.js';
import { notifyEmail } from './notify.js';
import { normalizeIlPhone } from './validate.js';

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const trackingUrl = (env, token) => `https://find.edenmish.com/t/${token}`;
// Business contact line for customer emails — the EdenMish business number only,
// never a private number. Single definition so the templates can't drift apart.
const SUPPORT_LINE = '<p style="color:#777;font-size:13px;margin-top:14px">לשאלות: eden@edenmish.com · 053-405-8498</p>';
const otpEmailHtml = (otp, url) => `<div dir="rtl" style="font-family:sans-serif;font-size:16px;line-height:1.6">הקוד שלך לאימות הכתובת ב-EdenMish:<div style="font-size:34px;font-weight:800;letter-spacing:6px;color:#5B2A86">${otp}</div>הקוד תקף 10 דקות.${url ? '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee"><a href="' + url + '" style="display:inline-block;background:#5B2A86;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700">מעקב המשלוח שלך ←</a></div>' : ''}</div>`;
const deliverySummaryHtml = (o) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px"><h2 style="color:#5B2A86;margin:0 0 8px">המשלוח נמסר ✓</h2><p>תודה שבחרתם ב-EdenMish!</p><table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:5px 14px;color:#777">איסוף</td><td style="padding:5px 0">${o.pickup || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">מסירה</td><td style="padding:5px 0">${o.dropoff || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">מחיר</td><td style="padding:5px 0;font-weight:700;color:#C9A96B;font-size:18px">₪${o.price || ''}</td></tr></table>${SUPPORT_LINE}</div>`;
const paymentConfirmedHtml = (o, url, otp) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px"><h2 style="color:#5B2A86;margin:0 0 8px">התשלום התקבל ✓</h2><p>תודה שבחרתם ב-EdenMish! ההזמנה מאושרת.</p><table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:5px 14px;color:#777">מס׳ הזמנה</td><td style="padding:5px 0">${o.id || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">מחיר</td><td style="padding:5px 0;font-weight:700;color:#C9A96B;font-size:18px">₪${o.price || ''}</td></tr></table><div style="margin:18px 0;padding:14px;background:#F5F2FB;border-radius:10px;text-align:center"><p style="margin:0 0 6px;font-size:14px;color:#555">קוד האימות למעקב המשלוח:</p><div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#5B2A86">${otp || '—'}</div></div><div style="text-align:center"><a href="${url}" style="display:inline-block;background:#5B2A86;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">מעקב המשלוח שלי ←</a></div>${SUPPORT_LINE}</div>`;
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Review-flagged orders: immediate confirmation so the customer knows what happens next
// (previously they got zero contact until after payment — a funnel dead end).
const requestReceivedHtml = (o) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px"><h2 style="color:#5B2A86;margin:0 0 8px">קיבלנו את הבקשה ✓</h2><p>עדן בודק את המסלול ויאשר את המחיר בהקדם. ברגע שהמחיר מאושר, יישלח אליכם למייל זה קישור לתשלום מאובטח.</p><table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:5px 14px;color:#777">מס׳ הזמנה</td><td style="padding:5px 0">${o.id || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">איסוף</td><td style="padding:5px 0">${escHtml(o.pickup)}</td></tr><tr><td style="padding:5px 14px;color:#777">מסירה</td><td style="padding:5px 0">${escHtml(o.dropoff)}</td></tr>${o.price ? `<tr><td style="padding:5px 14px;color:#777">מחיר משוער</td><td style="padding:5px 0;font-weight:700;color:#C9A96B">₪${o.price}</td></tr>` : ''}</table><p style="color:#777;font-size:13px;margin-top:10px">לאחר התשלום יישלח קישור מעקב חי וקוד אימות למייל.</p>${SUPPORT_LINE}</div>`;
// Sent by /approve: the confirmed price + Shopify checkout link (previously the link was
// only copied to Eden's clipboard and the customer was never notified).
const paymentLinkHtml = (o, url) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px"><h2 style="color:#5B2A86;margin:0 0 8px">המחיר אושר ✓</h2><p>הזמנה #${o.id || ''} מוכנה לתשלום.</p><table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:5px 14px;color:#777">איסוף</td><td style="padding:5px 0">${escHtml(o.pickup)}</td></tr><tr><td style="padding:5px 14px;color:#777">מסירה</td><td style="padding:5px 0">${escHtml(o.dropoff)}</td></tr><tr><td style="padding:5px 14px;color:#777">מחיר</td><td style="padding:5px 0;font-weight:700;color:#C9A96B;font-size:18px">₪${o.price || ''}</td></tr></table><div style="text-align:center;margin:18px 0"><a href="${url}" style="display:inline-block;background:#5B2A86;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">לתשלום מאובטח ←</a></div><p style="color:#777;font-size:13px">תשלום באשראי / ביט / Apple Pay דרך Shopify. לאחר התשלום יישלח קישור מעקב חי וקוד אימות למייל.</p>${SUPPORT_LINE}</div>`;

async function isOps(req, env) {
  const c = getCookie(req, 'ops_sess') || req.headers.get('X-Ops');
  return await checkSession(env, c);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const host = (req.headers.get('host') || '').toLowerCase();
    const path = url.pathname;
    const onFind = host.startsWith('find.');
    const onOps = host.startsWith('ops.');
    const cors = corsFor(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ---- public API (CORS) ----
    if (path === '/api/orders' && req.method === 'POST') {
      // Part E — IP-based abuse protection (best-effort; never blocks order creation).
      try {
        const k = await anonKey(env, clientIp(req));
        const r10 = await incrRateLimit(env.DB, 'ord:' + k, 10 * 60 * 1000);
        if (r10.count > 5) { console.log('order_rate_limited', { window: '10m' }); return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '600' }); }
        const rd = await incrRateLimit(env.DB, 'ordd:' + k, 24 * 60 * 60 * 1000);
        if (rd.count > 20) { console.log('order_rate_limited', { window: 'day' }); return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '86400' }); }
      } catch (rlErr) { console.error('rate_limit_error', rlErr && rlErr.message ? rlErr.message : String(rlErr)); }

      let b; try { b = await req.json(); } catch { return json({ error: 'invalid body' }, 400, cors); }
      // Part A — email is required for new public orders (tracking link + OTP go by email).
      const required = ['name', 'phone', 'email', 'pickup', 'dropoff', 'package'];
      for (const f of required) if (!b[f]) return json({ error: 'missing ' + f }, 400, cors);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) return json({ error: 'invalid email' }, 400, cors);
      // A typo'd phone is a failed delivery — normalize to E.164 or reject up front.
      const phone = normalizeIlPhone(b.phone);
      if (!phone) return json({ error: 'invalid phone' }, 400, cors);
      b = { ...b, phone };

      const rules = await getRules(env.DB);
      const pr = priceOrder(b, rules);
      const isReview = pr.review;

      // 1. Create the D1 order. For exact-price orders a Shopify Draft Order is created
      //    below (PR4); the customer pays its invoice URL through Shopify + PayPlus. The
      //    Shopify webhook links the order back via _tracking_token (line property) / note.
      const created = await createOrder(env.DB, {
        ...b,
        status: isReview ? 'review' : 'priced',
        price: pr.price,
        review_flag: isReview ? 1 : 0,
        review_reason: isReview ? pr.reasons.join(',') : null,
        payment_status: 'none',
        payment_mode: 'immediate'
      });
      const token = created.token;
      const finalUrl = trackingUrl(env, token);

      // Set OTP hash to gate the tracking page, but DON'T email the code yet.
      // The code is regenerated and emailed AFTER payment is confirmed (webhook handler).
      if (b.email) {
        const otp = genOtp();
        await setEmailAndOtp(env.DB, created.id, b.email, await hashOtp(env, otp), Date.now() + 2 * 60 * 60 * 1000);
      }

      // Notify Eden (optional)
      try {
        await notifyEmail(env, env.DB, { orderId: created.id, template: 'ops_new_order', recipient: env.OPS_EMAIL, subject: `הזמנה חדשה #${created.id}${isReview ? ' — לבדיקה' : ' — ממתינה לתשלום'}`, html: `${b.name} · ${b.pickup} → ${b.dropoff} · ₪${pr.price}${isReview ? '<br>חריג: ' + pr.reasons : ''}<br><a href="${finalUrl}">${finalUrl}</a>` });
      } catch {}

      // Review orders: tell the customer what happens next (Eden confirms the price,
      // then a payment link arrives by email). Without this they heard nothing at all
      // until after payment — most would assume the order vanished.
      if (isReview && b.email) {
        try { await notifyEmail(env, env.DB, { orderId: created.id, template: 'customer_request_received', recipient: b.email, subject: `קיבלנו את הבקשה ✓ — הזמנה #${created.id} ב-EdenMish`, html: requestReceivedHtml({ id: created.id, pickup: b.pickup, dropoff: b.dropoff, price: pr.price }) }); } catch {}
      }

      // 2. PR4 — exact-price path: Worker creates a Shopify Draft Order and returns its
      //    invoice URL. The customer pays it through Shopify checkout (PayPlus app). The
      //    Shopify orders/paid webhook reconciles it back to this order. Review/manual-quote
      //    orders skip this (Eden approves the price in ops first). If Shopify isn't
      //    configured (createCharge returns null) or it throws, paymentUrl stays null and
      //    the customer lands on the tracking page (pay-from-tracking / manual coordination).
      let paymentUrl = null;
      if (!isReview) {
        try {
          const charge = await createCharge(env, { ...b, id: created.id, token, price: pr.price }, pr.price);
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
        token, tracking_url: finalUrl,
        payment_url: paymentUrl,
        status: isReview ? 'review' : (paymentUrl ? 'payment_sent' : 'priced'),
        price: pr.price,
        review: isReview, reasons: pr.reasons
      }, 200, cors);
    }

    if (path.startsWith('/api/orders/') && req.method === 'GET') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o) return json({ error: 'not found' }, 404, cors);
      // Part B — full PII only after email verification. Unverified access (including
      // legacy no-email orders) gets the sanitized summary only.
      if (!o.email_verified) {
        return json({ order: publicOrderSummary(o), history: [], gps: null, otp_pending: true }, 200, cors);
      }
      const proofP = o.status === 'delivered' ? getDeliveryProof(env.DB, o.id) : Promise.resolve(null);
      const [history, gps, proof] = await Promise.all([getStatusHistory(env.DB, o.id), latestGps(env.DB, o.id), proofP]);
      delete o.otp_hash;
      return json({ order: o, history: history.results, gps, proof, otp_pending: false }, 200, cors);
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

    // ---- customer tracking page (find.) ----
    if (onFind && path.startsWith('/t/')) {
      const token = path.split('/')[2];
      return html(trackingHtml(env, token));
    }
    if (onFind && (path === '/' || path === '')) {
      return Response.redirect(env.BOOKING_URL || 'https://edenmish.com', 302);
    }

    // ---- ops dashboard (ops.) ----
    if (onOps && (path === '/' || path === '')) return html(opsHtml(env));

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
      const pinOk = !!(b.pin && env.OPS_PIN && (await hashOtp(env, String(b.pin))) === (await hashOtp(env, String(env.OPS_PIN))));
      if (pinOk) {
        if (RL) await resetRateLimit(env.DB, RL);
        const session = await makeSession(env);
        return json({ session }, 200, { 'Set-Cookie': `ops_sess=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` });
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

    if (onOps && path === '/api/ops/orders' && req.method === 'GET') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const r = await listOrders(env.DB);
      return json({ orders: r.results });
    }

    if (onOps && path.includes('/api/ops/orders/') && path.includes('/status') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      let b; try { b = await req.json(); } catch { b = {}; }
      const fields = {};
      if (b.status === 'picked_up') fields.picked_up_at = Date.now();
      if (b.status === 'paid') fields.payment_status = 'paid';
      if (b.status === 'delivered') { fields.delivered_at = Date.now(); fields.payment_status = fields.payment_status || 'paid'; }
      await setOrderStatus(env.DB, id, b.status, fields);
      if (b.status === 'paid') {
        const o = await getOrderById(env.DB, id);
        if (o) {
          await recordPayment(env.DB, id, { amount: o.price * 100, status: 'paid', paid_at: Date.now() });
          if (o.email) {
            const otp = genOtp();
            await setEmailAndOtp(env.DB, o.id, o.email, await hashOtp(env, otp), Date.now() + 10 * 60 * 1000);
            try { await notifyEmail(env, env.DB, { orderId: o.id, template: 'customer_payment_confirmation', recipient: o.email, subject: 'התשלום התקבל ✓ — קוד אימות וקישור למעקב', html: paymentConfirmedHtml({ ...o, email: o.email }, trackingUrl(env, o.token), otp) }); } catch {}
          }
          try { await notifyEmail(env, env.DB, { orderId: o.id, template: 'ops_payment_received', recipient: env.OPS_EMAIL, subject: `תשלום התקבל #${o.id} — ₪${o.price}`, html: `${o.name} · ${o.pickup} → ${o.dropoff}<br>המתינו לאישור ויציאה לדרך ב- ops.edenmish.com` }); } catch {}
        }
      }
      if (b.status === 'delivered') {
        const o = await getOrderById(env.DB, id);
        if (o) {
          await settleOrder(env, o);
          if (o.email) {
            try { await notifyEmail(env, env.DB, { orderId: o.id, template: 'customer_delivery_summary', recipient: o.email, subject: 'המשלוח מ-EdenMish נמסר ✓', html: deliverySummaryHtml(o) }); } catch {}
          }
        }
      }
      return json({ ok: true });
    }

    if (onOps && path.includes('/api/ops/orders/') && path.endsWith('/gps') && req.method === 'POST') {
      if (!(await isOps(req, env))) return json({ error: 'unauthorized' }, 401);
      const id = Number(path.split('/')[4]);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad' }, 400); }
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return json({ error: 'bad coords' }, 400);
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
            const sent = await notifyEmail(env, env.DB, { orderId: id, template: 'customer_payment_link', recipient: o.email, subject: `המחיר אושר ✓ — קישור לתשלום הזמנה #${id}`, html: paymentLinkHtml({ id, pickup: o.pickup, dropoff: o.dropoff, price }, charge.checkoutUrl) });
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
      let b; try { b = await req.json(); } catch { b = {}; }
      const before = await getOrderById(env.DB, id);
      await upsertDeliveryProof(env.DB, id, { receiver_name: b.receiver_name, delivery_note: b.delivery_note, photo_url: b.photo_url });
      const wasDelivered = !!(before && before.status === 'delivered');
      await setOrderStatus(env.DB, id, 'delivered', { delivered_at: (before && before.delivered_at) || Date.now(), payment_status: 'paid' });
      const o = await getOrderById(env.DB, id);
      if (!wasDelivered && o) {
        await settleOrder(env, o); // no-op in 'immediate' mode; captures in future 'preauth' (Mesh) mode
        if (o.email) {
          try { await notifyEmail(env, env.DB, { orderId: o.id, template: 'customer_delivery_summary', recipient: o.email, subject: 'המשלוח מ-EdenMish נמסר ✓', html: deliverySummaryHtml(o) }); } catch {}
        }
      }
      const proof = await getDeliveryProof(env.DB, id);
      return json({ ok: true, order: o, proof });
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

    // ---- Shopify webhook (replaces PayPlus webhook) ----
    // Fires when the customer completes checkout on the draft-order invoice URL.
    // Subscribe to `orders/paid` (immediate mode) and optionally `orders/create` in Shopify admin.
    if (path === '/webhooks/shopify' && req.method === 'POST') {
      const rawBody = await req.text();
      const hmac = req.headers.get('X-Shopify-Hmac-SHA256') || '';
      if (!(await verifyShopifyWebhook(env, rawBody, hmac))) return json({ error: 'invalid signature' }, 401);
      let b; try { b = JSON.parse(rawBody); } catch { return json({ error: 'bad json' }, 400); }
      const parsed = parseShopifyOrderWebhook(b);
      if (parsed.token) {
        const o = await getOrderByToken(env.DB, parsed.token);
        if (o) {
          if (parsed.paid) {
            // Idempotency: Shopify retries webhook deliveries. Re-processing would insert a
            // duplicate payment row, invalidate the customer's OTP, and re-send both emails.
            if (o.payment_status === 'paid') return json({ received: true });
            await setOrderStatus(env.DB, o.id, 'paid', { payment_status: 'paid', shopify_order_id: parsed.shopifyOrderId });
            await recordPayment(env.DB, o.id, { amount: o.price * 100, status: 'paid', payplus_id: String(parsed.shopifyOrderId), paid_at: Date.now() });
            // Use checkout email if the order doesn't have one (customer entered it in Shopify checkout)
            var custEmail = o.email || parsed.email;
            if (custEmail && env.SENDGRID_API_KEY) {
              const otp = genOtp();
              await setEmailAndOtp(env.DB, o.id, custEmail, await hashOtp(env, otp), Date.now() + 10 * 60 * 1000);
              try { await notifyEmail(env, env.DB, { orderId: o.id, template: 'customer_payment_confirmation', recipient: custEmail, subject: 'התשלום התקבל ✓ — קוד אימות וקישור למעקב', html: paymentConfirmedHtml({ ...o, email: custEmail }, trackingUrl(env, o.token), otp) }); } catch {}
            }
            try { await notifyEmail(env, env.DB, { orderId: o.id, template: 'ops_payment_received', recipient: env.OPS_EMAIL, subject: `תשלום התקבל #${o.id} — ₪${o.price}`, html: `${o.name} · ${o.pickup} → ${o.dropoff}<br>המתינו לאישור ויציאה לדרך ב- ops.edenmish.com` }); } catch {}
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
  }
};
