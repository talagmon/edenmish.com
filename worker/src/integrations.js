// Shopify (Draft Orders + webhooks) + email notifications + ops auth.
// All gated by env secrets — they no-op cleanly until keys are set.
//
// Payment processor: the PayPlus Shopify app handles card/Bit/Apple Pay inside
// Shopify checkout. This file never talks to PayPlus directly — it creates a
// Shopify Draft Order (with our computed price) and Shopify + PayPlus do the rest.

const enc = new TextEncoder();

// ---- Shopify Admin API: create a Draft Order at the given price ----
// The customer pays on the returned invoice_url via Shopify checkout (PayPlus app).
// `priceNis` is the FINAL amount. When a coupon was applied, the order carries
// `subtotal_price` + `discount_code` + `discount_amount` — we inflate the line-item
// to the original subtotal and attach an applied_discount so the Shopify checkout
// shows the discount breakdown to the customer.
// Requires: env.SHOPIFY_SHOP, env.SHOPIFY_ADMIN_TOKEN.
export async function createDraftOrder(env, order, priceNis) {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return null;
  const apiVersion = env.SHOPIFY_API_VERSION || '2026-04';
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${apiVersion}/draft_orders.json`;

  const SERVICE_HE = {
    eco: 'חסכוני (מסירה עד סוף היום)',
    standard: 'רגיל (מסירה בתוך 4 שעות)',
    flash: 'מהיר (מסירה בתוך 90 דקות)',
  };
  const SIZE_HE = { small: 'קטן', medium: 'בינוני' };
  const pkgTitle = 'שליחות — ' + (SERVICE_HE[order.service] || 'שליחות') + (order.size === 'medium' ? ' · עד גודל קופסת נעלים' : '');

  const discountAmount = Math.max(0, Math.round(Number(order.discount_amount) || 0));
  const hasDiscount = !!(order.discount_code && discountAmount > 0);
  const lineItemPrice = hasDiscount ? Number(order.subtotal_price) || (Number(priceNis) + discountAmount) : Number(priceNis);

  const properties = [
    { name: '_tracking_token', value: order.token },
    { name: 'איסוף', value: order.pickup || '—' },
    { name: 'מסירה', value: order.dropoff || '—' },
    { name: 'רמת שירות', value: SERVICE_HE[order.service] || order.service || '—' },
    { name: 'גודל', value: SIZE_HE[order.size] || '—' },
    { name: 'טלפון', value: order.phone || '—' },
  ];
  if (order.when_text) properties.push({ name: 'מועד', value: order.when_text });
  if (order.notes) properties.push({ name: 'הערות', value: order.notes });

  const body = {
    draft_order: {
      line_items: [{
        title: pkgTitle,
        price: lineItemPrice.toFixed(2),
        quantity: 1,
        requires_shipping: false,
        taxable: false,
        properties,
      }],
      tags: 'edenmish-delivery',
      note: `EdenMish token: ${order.token}`,
      metafields: [{
        namespace: 'edenmish',
        key: 'tracking_token',
        value: order.token,
        type: 'single_line_text_field',
      }],
    },
  };

  if (hasDiscount) {
    body.draft_order.applied_discount = {
      title: order.discount_code,
      description: 'EdenMish coupon',
      value_type: 'fixed_amount',
      value: discountAmount.toFixed(2),
      amount: discountAmount.toFixed(2),
    };
  }

  if (order.name || order.phone || (order.email && order.email_verified)) {
    body.draft_order.customer = {};
    if (order.name) body.draft_order.customer.first_name = order.name;
    if (order.phone) body.draft_order.customer.phone = order.phone;
    if (order.email && order.email_verified) body.draft_order.customer.email = order.email;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const draft = data && data.draft_order;
  if (!draft || !draft.invoice_url) return null;
  return draft; // { id, invoice_url, ... }
}

// Business wallet top-up. This intentionally has its own Draft Order shape so a
// prepaid credit purchase can never be mistaken for a delivery order.
export async function createWalletDraftOrder(env, topup, priceNis) {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return null;
  const apiVersion = env.SHOPIFY_API_VERSION || '2026-04';
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${apiVersion}/draft_orders.json`;
  const planName = topup.plan_name_he || topup.plan_id || 'עסקי';
  const body = {
    draft_order: {
      line_items: [{
        title: `יתרת משלוחים לעסקים — מסלול ${planName}`,
        price: Number(priceNis).toFixed(2),
        quantity: 1,
        requires_shipping: false,
        taxable: false,
        properties: [
          { name: '_edenmish_wallet_topup', value: topup.id },
          { name: 'מסלול', value: planName },
          { name: 'יתרה', value: `₪${Number(priceNis).toFixed(0)}` },
        ],
      }],
      tags: 'edenmish-wallet-topup',
      note: `EdenMish wallet topup: ${topup.id}`,
      metafields: [{
        namespace: 'edenmish',
        key: 'wallet_topup_token',
        value: topup.id,
        type: 'single_line_text_field',
      }],
      customer: topup.email ? { email: topup.email } : undefined,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const draft = data && data.draft_order;
  return draft && draft.invoice_url ? draft : null;
}

// ---- Shopify webhook HMAC verification (REQUIRED before trusting any webhook) ----
// Shopify signs every webhook with HMAC-SHA256 over the raw body, sent in the
// X-Shopify-Hmac-SHA256 header (base64). Compare in constant time.
export async function verifyShopifyWebhook(env, rawBody, hmacHeader) {
  if (!env.SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SHOPIFY_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (computed.length !== hmacHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  return diff === 0;
}

// ---- Parse Shopify order webhook → find our tracking token + payment status ----
// Fired when the draft order is completed at checkout (orders/create or orders/paid).
// We recover the EdenMish token from the note or metafields we set on the draft order.
export function parseShopifyOrderWebhook(body) {
  const o = body || {};
  const customer = o.customer || {};
  const billing = o.billing_address || {};
  const shipping = o.shipping_address || {};
  const joinedName = (source) => [source.first_name, source.last_name]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  let token = null;
  let walletTopupToken = null;
  // The funnel embeds _tracking_token in line item properties
  const lines = o.line_items || [];
  for (const li of lines) {
    const props = li.properties || [];
    for (const p of props) {
      if (p.name === '_tracking_token' && p.value) { token = p.value; break; }
      if (p.name === '_edenmish_wallet_topup' && p.value) walletTopupToken = p.value;
    }
    if (token) break;
  }
  // Fallback: metafield or note
  if (!token) {
    const meta = (o.metafields || []).find(m => m.namespace === 'edenmish' && m.key === 'tracking_token');
    token = (meta && meta.value) || null;
  }
  if (!token && typeof o.note === 'string') {
    const m = o.note.match(/token:\s*([a-f0-9]+)/i);
    if (m) token = m[1];
  }
  if (!walletTopupToken) {
    const meta = (o.metafields || []).find(m => m.namespace === 'edenmish' && m.key === 'wallet_topup_token');
    walletTopupToken = (meta && meta.value) || null;
  }
  if (!walletTopupToken && typeof o.note === 'string') {
    const m = o.note.match(/wallet\s+topup:\s*([A-Za-z0-9_-]+)/i);
    if (m) walletTopupToken = m[1];
  }
  // Conservative reconciliation: only a clearly paid/captured Shopify order is treated
  // as paid. `pending` / `authorized` / `partially_paid` / `voided` / `refunded` /
  // `partially_refunded` must NOT mark the internal order paid — the webhook handler's
  // non-paid branch just records the financial_status without flipping the order to paid.
  const paid = /^paid$/i.test((o.financial_status || '').trim());
  return {
    token,
    walletTopupToken,
    shopifyOrderId: o.id || null,
    draftOrderId: o.draft_order_id || null,
    paid,
    financial_status: o.financial_status || null,
    total: o.total_price || null,
    currency: o.currency || o.presentment_currency || null,
    email: o.email || customer.email || null,
    customerName: joinedName(customer) || joinedName(billing) || joinedName(shipping) || null,
    customerPhone: o.phone || customer.phone || billing.phone || shipping.phone || null,
    billingCompany: billing.company || shipping.company || null,
    raw: o,
  };
}

// ---- Parse Shopify refunds/create webhook ----
// Shopify emits refunds/create when the refund record is created, independently
// of when the gateway finishes moving money. Consumers must inspect transaction
// statuses and use orders/updated financial_status as the final fallback signal.
export function parseShopifyRefundWebhook(body) {
  const refund = body || {};
  const transactions = (refund.transactions || [])
    .filter((tx) => String(tx.kind || '').toLowerCase() === 'refund')
    .map((tx) => ({
      id: tx.id || null,
      status: String(tx.status || '').toLowerCase(),
      amount: Number(tx.amount),
      currency: tx.currency || null,
    }))
    .filter((tx) => Number.isFinite(tx.amount) && tx.amount >= 0);

  const amountFor = (status) => transactions
    .filter((tx) => tx.status === status)
    .reduce((sum, tx) => sum + tx.amount, 0);

  return {
    refundId: refund.id || null,
    shopifyOrderId: refund.order_id || null,
    transactions,
    successfulAmount: amountFor('success'),
    pendingAmount: amountFor('pending'),
    hasFailedTransaction: transactions.some((tx) => ['failure', 'error'].includes(tx.status)),
    currency: (transactions.find((tx) => tx.currency) || {}).currency || null,
    raw: refund,
  };
}

// ---- Email via SendGrid ----
export async function sendEmail(env, { to, subject, html }) {
  if (!env.SENDGRID_API_KEY || !to) return null;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'no-reply@edenmish.com', name: 'EdenMish' },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  }).catch(() => null);
  return !!(res && (res.ok || res.status === 202));
}

// ---- WhatsApp Business Cloud API (optional) ----
// Gated on env.WHATSAPP_TOKEN + env.WHATSAPP_PHONE_ID; no-ops cleanly otherwise.
// Note: business-initiated messages to a recipient may require a pre-approved
// template depending on the WhatsApp Business account setup.
export async function sendWhatsApp(env, { to, body }) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID || !to) return null;
  const num = String(to).replace(/\D/g, '');
  const res = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'text', text: { body: String(body).slice(0, 4000) } })
  }).catch(() => null);
  return !!(res && res.ok);
}

// ---- OTP helpers ----
export function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
export async function hashOtp(env, code) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  return hmac(env.SESSION_SECRET, 'otp:' + code);
}

export function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

// ---- Ops auth (signed cookie) ----
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '');
}
export async function makeSession(env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  const payload = btoa(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 8 })).replace(/=/g, '');
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}
export async function checkSession(env, cookie) {
  if (!cookie || !env.SESSION_SECRET) return false;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return false;
  const expect = await hmac(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(expect, sig)) return false;
  try { return JSON.parse(atob(payload)).exp > Date.now(); } catch { return false; }
}
export function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
