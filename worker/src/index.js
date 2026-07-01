import { createOrder, getOrderByToken, getOrderById, listOrders, setOrderStatus, getStatusHistory, addGps, latestGps, getRules, recordPayment, setEmailAndOtp, verifyOtp } from './db.js';
import { priceOrder } from './pricing.js';
import { sendEmail, makeSession, checkSession, getCookie, genOtp, hashOtp } from './integrations.js';
import { createCharge, settleOrder, verifyShopifyWebhook, parseShopifyOrderWebhook } from './payment.js';
import { trackingHtml, opsHtml } from './pages.js';

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ops'
};
const trackingUrl = (env, token) => `https://find.edenmish.com/t/${token}`;
const otpEmailHtml = (otp, url) => `<div dir="rtl" style="font-family:sans-serif;font-size:16px;line-height:1.6">הקוד שלך לאימות הכתובת ב-EdenMish:<div style="font-size:34px;font-weight:800;letter-spacing:6px;color:#5B2A86">${otp}</div>הקוד תקף 10 דקות.${url ? '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee"><a href="' + url + '" style="display:inline-block;background:#5B2A86;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700">מעקב המשלוח שלך ←</a></div>' : ''}</div>`;
const deliverySummaryHtml = (o) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px"><h2 style="color:#5B2A86;margin:0 0 8px">המשלוח נמסר ✓</h2><p>תודה שבחרתם ב-EdenMish!</p><table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:5px 14px;color:#777">איסוף</td><td style="padding:5px 0">${o.pickup || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">מסירה</td><td style="padding:5px 0">${o.dropoff || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">מחיר</td><td style="padding:5px 0;font-weight:700;color:#C9A96B;font-size:18px">₪${o.price || ''}</td></tr></table><p style="color:#777;font-size:13px;margin-top:14px">לשאלות: eden@edenmish.com · 053-405-8498</p></div>`;
const paymentConfirmedHtml = (o, url, otp) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px"><h2 style="color:#5B2A86;margin:0 0 8px">התשלום התקבל ✓</h2><p>תודה שבחרתם ב-EdenMish! ההזמנה מאושרת.</p><table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:5px 14px;color:#777">מס׳ הזמנה</td><td style="padding:5px 0">${o.id || ''}</td></tr><tr><td style="padding:5px 14px;color:#777">מחיר</td><td style="padding:5px 0;font-weight:700;color:#C9A96B;font-size:18px">₪${o.price || ''}</td></tr></table><div style="margin:18px 0;padding:14px;background:#F5F2FB;border-radius:10px;text-align:center"><p style="margin:0 0 6px;font-size:14px;color:#555">קוד האימות למעקב המשלוח:</p><div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#5B2A86">${otp || '—'}</div></div><div style="text-align:center"><a href="${url}" style="display:inline-block;background:#5B2A86;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">מעקב המשלוח שלי ←</a></div><p style="color:#777;font-size:13px;margin-top:14px">לשאלות: eden@edenmish.com · 053-590-9043</p></div>`;

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

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ---- public API (CORS) ----
    if (path === '/api/orders' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return json({ error: 'invalid body' }, 400, cors); }
      const required = ['name', 'phone', 'pickup', 'dropoff', 'package'];
      for (const f of required) if (!b[f]) return json({ error: 'missing ' + f }, 400, cors);

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
        await sendEmail(env, { to: env.OPS_EMAIL, subject: `הזמנה חדשה #${created.id}${isReview ? ' — לבדיקה' : ' — ממתינה לתשלום'}`, html: `${b.name} · ${b.pickup} → ${b.dropoff} · ₪${pr.price}${isReview ? '<br>חריג: ' + pr.reasons : ''}<br><a href="${finalUrl}">${finalUrl}</a>` });
      } catch {}

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
      const [history, gps] = await Promise.all([getStatusHistory(env.DB, o.id), latestGps(env.DB, o.id)]);
      delete o.otp_hash;
      const otpPending = !!(o.otp_expires) && !o.email_verified;
      if (otpPending) {
        return json({ order: { id: o.id, token: o.token, email: o.email, status: o.status }, history: [], gps: null, otp_pending: true }, 200, cors);
      }
      return json({ order: o, history: history.results, gps, otp_pending: false }, 200, cors);
    }

    // ---- email OTP verify / resend (public, token-based) ----
    if (path.includes('/verify-otp') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o) return json({ error: 'not found' }, 404, cors);
      let b; try { b = await req.json(); } catch { b = {}; }
      if (!o.otp_expires || o.otp_expires < Date.now()) return json({ verified: false, error: 'expired' }, 200, cors);
      const expect = await hashOtp(env, String(b.code || ''));
      if (expect === o.otp_hash) { await verifyOtp(env.DB, o.id); return json({ verified: true }, 200, cors); }
      return json({ verified: false }, 200, cors);
    }
    if (path.includes('/resend-otp') && req.method === 'POST') {
      const token = path.split('/')[3];
      const o = await getOrderByToken(env.DB, token);
      if (!o || !o.email) return json({ ok: false }, 404, cors);
      const otp = genOtp();
      await setEmailAndOtp(env.DB, o.id, o.email, await hashOtp(env, otp), Date.now() + 10 * 60 * 1000);
      try { await sendEmail(env, { to: o.email, subject: 'קוד האימות שלך ב-EdenMish', html: otpEmailHtml(otp, trackingUrl(env, token)) }); } catch {}
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
      if (b.pin && b.pin === env.OPS_PIN) {
        const session = await makeSession(env);
        return json({ session }, 200, { 'Set-Cookie': `ops_sess=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` });
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
      if (b.status === 'delivered') { fields.delivered_at = Date.now(); fields.payment_status = fields.payment_status || 'paid'; }
      await setOrderStatus(env.DB, id, b.status, fields);
      if (b.status === 'delivered') {
        const o = await getOrderById(env.DB, id);
        if (o) {
          await settleOrder(env, o); // no-op in 'immediate' mode; captures in future 'preauth' (Mesh) mode
          if (o.email) {
            try { await sendEmail(env, { to: o.email, subject: 'המשלוח מ-EdenMish נמסר ✓', html: deliverySummaryHtml(o) }); } catch {}
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
      const price = Number(b.price) || o.price;
      const charge = await createCharge(env, { ...o }, price);
      if (charge) {
        await env.DB.prepare('UPDATE orders SET price=?, review_flag=0, review_reason=NULL, payment_url=?, shopify_draft_order_id=?, payment_status=?, payment_mode=?, status=? WHERE id=?')
          .bind(price, charge.checkoutUrl, charge.draftOrderId, 'link_sent', charge.mode, 'payment_sent', id).run();
        await setOrderStatus(env.DB, id, 'payment_sent');
        await recordPayment(env.DB, id, { amount: price * 100, status: 'link_sent', url: charge.checkoutUrl });
        return json({ ok: true, payment_url: charge.checkoutUrl });
      }
      // No Shopify credentials configured — fall back to priced state for WhatsApp quoting.
      await env.DB.prepare('UPDATE orders SET price=?, review_flag=0, review_reason=NULL, status=? WHERE id=?')
        .bind(price, 'priced', id).run();
      await setOrderStatus(env.DB, id, 'priced');
      return json({ ok: true, payment_url: null });
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
            await setOrderStatus(env.DB, o.id, 'paid', { payment_status: 'paid', shopify_order_id: parsed.shopifyOrderId });
            await recordPayment(env.DB, o.id, { amount: o.price * 100, status: 'paid', payplus_id: String(parsed.shopifyOrderId), paid_at: Date.now() });
            // Use checkout email if the order doesn't have one (customer entered it in Shopify checkout)
            var custEmail = o.email || parsed.email;
            if (custEmail && env.SENDGRID_API_KEY) {
              const otp = genOtp();
              await setEmailAndOtp(env.DB, o.id, custEmail, await hashOtp(env, otp), Date.now() + 10 * 60 * 1000);
              try { await sendEmail(env, { to: custEmail, subject: 'התשלום התקבל ✓ — קוד אימות וקישור למעקב', html: paymentConfirmedHtml({ ...o, email: custEmail }, trackingUrl(env, o.token), otp) }); } catch {}
            }
            try { await sendEmail(env, { to: env.OPS_EMAIL, subject: `תשלום התקבל #${o.id} — ₪${o.price}`, html: `${o.name} · ${o.pickup} → ${o.dropoff}<br>המתינו לאישור ויציאה לדרך ב- ops.edenmish.com` }); } catch {}
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
