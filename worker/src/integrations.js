// Shopify (Draft Orders + webhooks) + email notifications + ops auth.
// All gated by env secrets — they no-op cleanly until keys are set.
//
// Payment processor: the PayPlus Shopify app handles card/Bit/Apple Pay inside
// Shopify checkout. This file never talks to PayPlus directly — it creates a
// Shopify Draft Order (with our computed price) and Shopify + PayPlus do the rest.

const enc = new TextEncoder();

// ---- Shopify Admin API: create a Draft Order with a custom (dynamic) price ----
// The customer pays on the returned invoice_url via Shopify checkout (PayPlus app).
// Draft Orders support arbitrary line-item prices → this is how dynamic pricing
// fits inside Shopify checkout.
//
// Requires: env.SHOPIFY_SHOP (e.g. 'edenmish.myshopify.com'), env.SHOPIFY_ADMIN_TOKEN.
// See .env.example → SHOPIFY_ADMIN_ACCESS_TOKEN (shpat_...).
export async function createDraftOrder(env, order, priceNis) {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return null;
  const apiVersion = env.SHOPIFY_API_VERSION || '2026-04';
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${apiVersion}/draft_orders.json`;

  const SERVICE_HE = { eco: 'Eco (עד סוף יום)', standard: 'Standard (4 שעות)', flash: 'Flash (90 דקות)' };
  const SIZE_HE = { small: 'קטן', medium: 'בינוני' };
  const pkgTitle = 'שליחות — ' + (SERVICE_HE[order.service] || 'שליחות') + (order.size === 'medium' ? ' · עד גודל קופסת נעלים' : '');

  // Coupon (migration 008): the line item keeps the ORIGINAL subtotal and the
  // discount is attached as Shopify's applied_discount. Always fixed_amount — even
  // for percentage coupons — so the Shopify checkout total is exactly `priceNis`
  // (the Worker's final integer-shekel price) with no percentage re-rounding drift.
  // Non-coupon orders: hasDiscount is false and the payload is unchanged.
  const discountAmount = Math.max(0, Math.round(Number(order.discount_amount) || 0));
  const hasDiscount = !!(order.discount_code && discountAmount > 0);
  const lineItemPrice = Number(priceNis) + (hasDiscount ? discountAmount : 0);

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
      // Canonical Shopify decimal format ("5.00"), matching the line-item price above.
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

// ---- Shopify Admin GraphQL: look up a discount code definition ----
// Coupons are created/edited in Shopify Admin; the Worker syncs their definition
// into the D1 `coupons` table (see src/coupons.js) and enforces them server-side.
//
// Returns a `coupons` row shape (migrations/008_coupons.sql), or:
//   null                  → Shopify says no such code exists
//   { unsupported: true } → the code exists but is not a Basic code discount
//                           (BxGy / free shipping / app discount) or has a value
//                           shape we don't handle
// Throws on missing credentials / network / HTTP / GraphQL errors so the caller
// can fall back to its cached D1 row (stale-while-error).
export async function fetchShopifyDiscountByCode(env, code) {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) throw new Error('shopify_not_configured');
  const apiVersion = env.SHOPIFY_API_VERSION || '2026-04';
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${apiVersion}/graphql.json`;

  const query = `query DiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          title
          status
          startsAt
          endsAt
          usageLimit
          appliesOncePerCustomer
          customerGets {
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount currencyCode } }
            }
          }
        }
      }
    }
  }`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { code } }),
  });
  if (!res.ok) throw new Error('shopify_http_' + res.status);
  const data = await res.json();
  if (data.errors && data.errors.length) throw new Error('shopify_graphql_error');

  const node = data.data && data.data.codeDiscountNodeByCode;
  if (!node) return null; // no such code in Shopify
  const d = node.codeDiscount;
  if (!d || d.__typename !== 'DiscountCodeBasic') return { unsupported: true };

  const val = d.customerGets && d.customerGets.value;
  let value_type = null;
  let value = null;
  if (val && val.__typename === 'DiscountPercentage' && typeof val.percentage === 'number') {
    value_type = 'percentage';
    // GraphQL returns a 0..1 fraction (0.15 = 15%); we store 0-100.
    // Round to 2 decimals to shed float dust (0.15 * 100 === 15.000000000000002).
    value = Math.round(val.percentage * 100 * 100) / 100;
  } else if (val && val.__typename === 'DiscountAmount' && val.amount) {
    value_type = 'fixed_amount';
    value = Number(val.amount.amount); // ILS — same money unit as pricing.js
  }
  if (value_type == null || !Number.isFinite(value)) return { unsupported: true };

  return {
    code: String(code).trim().toUpperCase(),
    shopify_discount_id: node.id || null,
    title: d.title || null,
    value_type,
    value,
    status: String(d.status || '').toLowerCase() || null, // 'active' | 'expired' | 'scheduled'
    starts_at: d.startsAt ? Date.parse(d.startsAt) : null, // epoch ms
    ends_at: d.endsAt ? Date.parse(d.endsAt) : null,
    usage_limit: d.usageLimit ?? null, // NULL = unlimited
    applies_once_per_customer: d.appliesOncePerCustomer ? 1 : 0,
    raw_shopify_json: JSON.stringify(node),
  };
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
  let token = null;
  // The funnel embeds _tracking_token in line item properties
  const lines = o.line_items || [];
  for (const li of lines) {
    const props = li.properties || [];
    for (const p of props) {
      if (p.name === '_tracking_token' && p.value) { token = p.value; break; }
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
  // Conservative reconciliation: only a clearly paid/captured Shopify order is treated
  // as paid. `pending` / `authorized` / `partially_paid` / `voided` / `refunded` /
  // `partially_refunded` must NOT mark the internal order paid — the webhook handler's
  // non-paid branch just records the financial_status without flipping the order to paid.
  const paid = /^paid$/i.test((o.financial_status || '').trim());
  return {
    token,
    shopifyOrderId: o.id || null,
    paid,
    financial_status: o.financial_status || null,
    total: o.total_price || null,
    email: o.email || (o.customer && o.customer.email) || null,
    customerName: (o.customer && (o.customer.first_name + ' ' + o.customer.last_name).trim()) || o.email || null,
    raw: o,
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
export async function hashOtp(env, code) { return hmac(env.SESSION_SECRET || 'dev', 'otp:' + code); }

// ---- Ops auth (signed cookie) ----
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '');
}
export async function makeSession(env) {
  const payload = btoa(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 12 })).replace(/=/g, '');
  const sig = await hmac(env.SESSION_SECRET || 'dev', payload);
  return `${payload}.${sig}`;
}
export async function checkSession(env, cookie) {
  if (!cookie) return false;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return false;
  const expect = await hmac(env.SESSION_SECRET || 'dev', payload);
  if (expect !== sig) return false;
  try { return JSON.parse(atob(payload)).exp > Date.now(); } catch { return false; }
}
export function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
