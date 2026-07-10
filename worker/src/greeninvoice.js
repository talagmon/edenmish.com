// GreenInvoice (חשבונית ירוקה) — Israeli digital invoicing.
// Auto-generates a receipt with full price breakdown when an order is paid.
// Secrets: GREENINVOICE_API_KEY, GREENINVOICE_SECRET_KEY (set via wrangler secret put).

import { zoneOf } from './pricing.js';

const API_BASE = 'https://api.greeninvoice.co.il/api/v1';

async function giRequest(env, method, path, body) {
  if (!env.GREENINVOICE_API_KEY || !env.GREENINVOICE_SECRET_KEY) throw new Error('Missing GREENINVOICE_API_KEY or GREENINVOICE_SECRET_KEY');
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'X-GI-API-KEY': env.GREENINVOICE_API_KEY,
      'X-GI-SECRET-KEY': env.GREENINVOICE_SECRET_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = 'GI API ' + res.status + ': ' + text.slice(0, 200);
    console.error('greeninvoice_error', { status: res.status, body: text.slice(0, 500) });
    throw new Error(msg);
  }
  return res.json();
}

function isWeekend(yyyymmdd) {
  if (!yyyymmdd) return false;
  const m = String(yyyymmdd).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return day === 6; // Saturday only
}

const SERVICE_HE = { eco: 'Eco (עד סוף יום)', standard: 'Standard (4 שעות)', flash: 'Flash (90 דקות)' };

// Create a receipt with full price breakdown. Returns { id, number, url } or null.
// Never throws — invoice failure must not block order processing.
export async function createInvoice(env, order) {
    console.log('gi_start', { id: order.id, hasApiKey: !!env.GREENINVOICE_API_KEY, hasSecret: !!env.GREENINVOICE_SECRET_KEY, price: order.price, email: order.email });
    const name = (order.name || 'לקוח').trim();
    const email = (order.email || '').trim();
    const phone = (order.phone || '').trim();
    const finalPrice = Math.round(Number(order.price) || 0);

    // ---- Build price breakdown ----
    const income = [];
    const service = String(order.service || 'standard').toLowerCase();
    const size = String(order.size || 'small').toLowerCase();
    const pz = zoneOf(order.pickup_city);
    const dz = zoneOf(order.dropoff_city);
    const zone = (pz && dz) ? Math.max(pz, dz) : null;
    const hour = Number(order.when_hour);
    const wknd = isWeekend(order.when_date);
    const discountAmount = Math.round(Number(order.discount_amount) || 0);
    const hasDiscount = !!(order.discount_code && discountAmount > 0);

    // 1. Base delivery
    const svcLabel = SERVICE_HE[service] || 'שליחות';
    const zoneLabel = zone ? `אזור ${zone}` : '';
    income.push({
      description: `שליחות ${svcLabel} · ${zoneLabel}`.replace(/ · $/, '').trim(),
      quantity: 1,
      price: finalPrice, // placeholder — we'll compute the real breakdown below
      currency: 'ILS',
      vatType: 0,
    });

    // Recompute the real breakdown using the same logic as pricing.js
    const DEFAULTS = {
      eco_z1: 35, eco_z2: 55, eco_z3: 75,
      std_z1: 50, std_z2: 70, std_z3: 115,
      flash_z1: 85, flash_z2: 110,
      sur_medium: 15, sur_evening: 30, weekend_mult: 1.5,
    };

    let base = 50; // fallback
    if (zone) {
      if (service === 'eco') base = DEFAULTS['eco_z' + zone] || base;
      else if (service === 'flash') base = DEFAULTS['flash_z' + zone] || base;
      else base = DEFAULTS['std_z' + zone] || base;
    }

    income[0].price = base;

    // 2. Medium size surcharge
    if (size === 'medium') {
      income.push({
        description: 'תוספת גודל בינוני (עד קופסת נעליים)',
        quantity: 1,
        price: DEFAULTS.sur_medium,
        currency: 'ILS',
        vatType: 0,
      });
    }

    // 3. Evening surcharge
    if (hour >= 19 && hour < 22) {
      income.push({
        description: 'תוספת ערב (19:00–22:00)',
        quantity: 1,
        price: DEFAULTS.sur_evening,
        currency: 'ILS',
        vatType: 0,
      });
    }

    // 4. Weekend multiplier — show as a separate surcharge line
    if (wknd) {
      const subtotalBeforeWeekend = income.reduce((s, item) => s + item.price, 0);
      const weekendExtra = Math.round(subtotalBeforeWeekend * (DEFAULTS.weekend_mult - 1));
      if (weekendExtra > 0) {
        income.push({
          description: `תוספת סופ״ש (×${DEFAULTS.weekend_mult})`,
          quantity: 1,
          price: weekendExtra,
          currency: 'ILS',
          vatType: 0,
        });
      }
    }

    // 5. Discount (coupon)
    if (hasDiscount) {
      income.push({
        description: `קופון ${order.discount_code}${order.discount_title ? ' — ' + order.discount_title : ''}`,
        quantity: 1,
        price: -discountAmount,
        currency: 'ILS',
        vatType: 0,
      });
    }

    // Compute total from breakdown (should match finalPrice)
    const computedTotal = income.reduce((s, item) => s + item.price, 0);

    // GreenInvoice document payload
    const doc = {
      type: 405, // receipt for exempt dealer (עוסק פטור)
      date: new Date().toISOString().split('T')[0],
      lang: 'he',
      currency: 'ILS',
      vatType: 0,
      rounding: false,
      signed: true,
      client: {
        name,
        emails: email ? [email] : [],
        phone: phone || undefined,
        add: false,
      },
      income,
      payment: [
        {
          type: 1, // credit card
          price: computedTotal,
          currency: 'ILS',
          date: new Date().toISOString().split('T')[0],
        },
      ],
      remarks: [
        order.token ? `Token: ${order.token}` : '',
        `איסוף: ${order.pickup || '—'}`,
        `מסירה: ${order.dropoff || '—'}`,
      ].filter(Boolean).join(' · '),
    };

    console.log('gi_sending', { id: order.id, docType: doc.type, client: doc.client.name, items: doc.income.length, total: computedTotal });
    const result = await giRequest(env, 'POST', '/documents', doc);
    if (!result) { console.log('gi_api_failed', { id: order.id }); return null; }
    console.log('gi_success', { id: order.id, number: result.number, url: result.url?.he || result.url?.orig });

    return {
      id: result.id,
      number: result.number,
      url: result.url?.he || result.url?.orig || null,
    };
}

// Fetch an existing invoice by ID (for status checks or re-sending).
export async function getInvoice(env, invoiceId) {
  try {
    return await giRequest(env, 'GET', `/documents/${invoiceId}`);
  } catch (e) {
    console.error('greeninvoice_get_error', e && e.message ? e.message : String(e));
    return null;
  }
}
