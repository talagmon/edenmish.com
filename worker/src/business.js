// Business accounts and prepaid wallet domain.
// Shopify/PayPlus collect top-up payments; Worker + D1 own identity, credit and spend.

import { getCookie, genOtp, timingSafeEqual } from './integrations.js';
import { incrRateLimit } from './db.js';
import { anonKey, clientIp } from './security.js';
import { notifyEmail } from './notify.js';
import { DEFAULT_PRICING_RULES } from './pricing.js';

const enc = new TextEncoder();
const DAY = 24 * 60 * 60 * 1000;
const AUTH_TTL_MS = 10 * 60 * 1000;
export const BUSINESS_SESSION_TTL_MS = 3 * DAY;
export const BUSINESS_SESSION_COOKIE = 'business_session';
export const RATE_PLAN_VERSION = '2026-07-v2';

export const BUSINESS_PLANS = Object.freeze({
  trial: Object.freeze({ id: 'trial', name_he: 'חבילת ניסיון', amount_agorot: 15_000, zones: [1], priority: 'normal', credit_valid_days: 14, one_per_account: true }),
  wallet: Object.freeze({ id: 'wallet', name_he: 'ארנק עסקי', amount_agorot: 150_000, zones: [1], priority: 'normal', credit_valid_days: 30 }),
  silver: Object.freeze({ id: 'silver', name_he: 'כסף', amount_agorot: 60_000, zones: [1], priority: 'normal', credit_valid_days: 60 }),
  gold: Object.freeze({ id: 'gold', name_he: 'זהב', amount_agorot: 150_000, zones: [1, 2], priority: 'priority', credit_valid_days: 60 }),
  platinum: Object.freeze({ id: 'platinum', name_he: 'פלטינום', amount_agorot: 300_000, zones: [1, 2, 3], priority: 'first', credit_valid_days: 60 }),
});

const MEMBER_BASE_RATES = Object.freeze({
  trial: Object.freeze({ '1:eco': 30 }),
  wallet: Object.freeze({ '1:eco': 30 }),
  silver: Object.freeze({ '1:eco': 30, '1:standard': 45 }),
  gold: Object.freeze({ '1:eco': 30, '1:standard': 45, '1:flash': 85, '2:eco': 50, '2:standard': 65, '2:flash': 110 }),
  platinum: Object.freeze({ '1:eco': 30, '1:standard': 45, '1:flash': 80, '2:eco': 48, '2:standard': 63, '2:flash': 105, '3:eco': 68, '3:standard': 104 }),
});

const BUSINESS_PLAN_VALUE = Object.freeze({
  trial: Object.freeze({
    best_for: 'לעסק שרוצה לבדוק את השירות בלי התחייבות',
    example_rate_key: '1:eco',
    benefits: Object.freeze(['5 משלוחים חסכוניים באזור 1', 'קרדיט תקף ל־14 יום', 'חבילת ניסיון אחת לכל עסק']),
  }),
  wallet: Object.freeze({
    best_for: 'לעסק עם משלוחים חסכוניים קבועים באזור 1',
    example_rate_key: '1:eco',
    benefits: Object.freeze(['עד 50 משלוחים חסכוניים באזור 1', 'קרדיט תקף ל־30 יום', 'חשבון, יתרה והיסטוריית חיובים בזמן אמת']),
  }),
  silver: Object.freeze({
    best_for: 'לעסקים עם משלוחים קבועים במרכז תל אביב וגוש דן',
    example_rate_key: '1:standard',
    benefits: Object.freeze(['מחירי עסק באזור 1', 'משלוחים חסכוניים ורגילים', 'מעקב מלא אחרי היתרה והחיובים']),
  }),
  gold: Object.freeze({
    best_for: 'לעסקים שצריכים יותר כיסוי, גמישות ועדיפות',
    example_rate_key: '2:standard',
    recommended: true,
    benefits: Object.freeze(['כיסוי אזורים 1–2', 'כולל משלוח מהיר', 'עדיפות בתור המשלוחים']),
  }),
  platinum: Object.freeze({
    best_for: 'לעסקים עם נפח גבוה שצריכים את כל אזורי השירות',
    example_rate_key: '3:standard',
    benefits: Object.freeze(['כיסוי מלא באזורים 1–3', 'המחירים העסקיים הטובים ביותר', 'עדיפות ראשונה וזמני טיפול מהירים']),
  }),
});

const SERVICE_LABELS_HE = Object.freeze({ eco: 'חסכוני', standard: 'רגיל', flash: 'מהיר' });

function publicBaseRate(rateKey) {
  const [zone, service] = String(rateKey).split(':');
  const prefix = service === 'standard' ? 'std' : service;
  const value = DEFAULT_PRICING_RULES[`${prefix}_z${zone}`];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function planValue(plan) {
  const value = BUSINESS_PLAN_VALUE[plan.id];
  const memberRates = MEMBER_BASE_RATES[plan.id];
  const [zone, service] = value.example_rate_key.split(':');
  const memberRate = Number(memberRates[value.example_rate_key]);
  const publicRate = publicBaseRate(value.example_rate_key);
  const amount = plan.amount_agorot / 100;
  const deliveries = Math.floor(amount / memberRate);
  const savingsPerDelivery = Math.max(0, publicRate - memberRate);
  const maxDiscountPercent = Math.max(...Object.entries(memberRates).map(([key, rate]) => {
    const regular = publicBaseRate(key);
    return regular ? Math.round(((regular - Number(rate)) / regular) * 100) : 0;
  }));
  return {
    best_for: value.best_for,
    recommended: Boolean(value.recommended),
    benefits: [...value.benefits],
    credit_valid_days: plan.credit_valid_days,
    repeatable: !plan.one_per_account,
    max_discount_percent: maxDiscountPercent,
    example: {
      zone: Number(zone),
      service,
      service_he: SERVICE_LABELS_HE[service],
      public_rate: publicRate,
      member_rate: memberRate,
      saving_per_delivery: savingsPerDelivery,
      deliveries,
      estimated_savings: deliveries * savingsPerDelivery,
      credit_remaining: amount - deliveries * memberRate,
    },
  };
}

export function estimateBusinessDeliveries(availableAgorot, planId) {
  const plan = BUSINESS_PLANS[planId];
  if (!plan) return null;
  const example = planValue(plan).example;
  const available = Math.max(0, Number(availableAgorot) || 0) / 100;
  return {
    count: Math.floor(available / example.member_rate),
    rate: example.member_rate,
    zone: example.zone,
    service: example.service,
    service_he: example.service_he,
  };
}

export function publicBusinessPlans() {
  return Object.values(BUSINESS_PLANS).map((plan) => ({
    id: plan.id,
    name_he: plan.name_he,
    amount: plan.amount_agorot / 100,
    zones: plan.zones,
    priority: plan.priority,
    rates: { ...MEMBER_BASE_RATES[plan.id] },
    value: planValue(plan),
  }));
}

export function applyBusinessPlanPricing(quote, planId) {
  const plan = BUSINESS_PLANS[planId];
  const key = `${quote && quote.zone}:${quote && quote.service}`;
  const memberBase = plan && MEMBER_BASE_RATES[planId] && MEMBER_BASE_RATES[planId][key];
  if (!plan || !quote || quote.review || !Number.isFinite(memberBase)) {
    return {
      ...(quote || {}),
      available: false,
      review: true,
      reasons: [...new Set([...(quote && quote.reasons || []), 'plan_service_unavailable'])],
      plan_id: planId || null,
      rate_plan_version: RATE_PLAN_VERSION,
    };
  }
  const current = quote.breakdown || {};
  const medium = Number(current.medium_surcharge) || 0;
  const evening = Number(current.evening_surcharge) || 0;
  const multiplier = Number(current.weekend_multiplier) || 1;
  const beforeWeekend = memberBase + medium + evening;
  const total = Math.round(beforeWeekend * multiplier);
  return {
    ...quote,
    price: total,
    base: memberBase,
    review: false,
    available: true,
    reasons: [],
    plan_id: planId,
    rate_plan_version: RATE_PLAN_VERSION,
    public_price: quote.price,
    savings: Math.max(0, Number(quote.price) - total),
    breakdown: {
      ...current,
      base: memberBase,
      weekend_surcharge: Math.max(0, total - beforeWeekend),
      total,
    },
  };
}

export function normalizeBusinessEmail(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

// Business-plan coupon limits belong to the shared business account, not to an
// individual member email. This prevents two members of one account from each
// redeeming a coupon marked as once per customer.
export function businessCouponCustomerKey(sessionOrAccountId) {
  const raw = sessionOrAccountId && typeof sessionOrAccountId === 'object'
    ? sessionOrAccountId.account_id
    : sessionOrAccountId;
  const accountId = Number(raw);
  return Number.isSafeInteger(accountId) && accountId > 0 ? `business:${accountId}` : null;
}

function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacHex(env, purpose, value) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`business:${purpose}:${value}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginEmailHtml(code, magicUrl) {
  return `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.7;max-width:480px;margin:auto;padding:28px;background:#fff;color:#0F172A;border:1px solid #e5dbee;border-radius:18px"><h1 style="color:#5B2A86;font-size:25px;margin:0 0 8px">כניסה לחשבון העסקי</h1><p style="color:#475569">לחצו על הכפתור לכניסה מיידית. הקישור והקוד תקפים ל-10 דקות ופועלים פעם אחת בלבד.</p><p style="text-align:center;margin:24px 0"><a href="${esc(magicUrl)}" style="display:inline-block;background:#5B2A86;color:#fff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700">כניסה מאובטחת לחשבון</a></p><div style="text-align:center;padding:18px;background:#f7f3fa;border-radius:12px"><div style="font-size:13px;color:#64748b">או הזינו את הקוד</div><div style="font-size:34px;font-weight:800;letter-spacing:7px;color:#5B2A86;direction:ltr">${esc(code)}</div></div><p style="font-size:13px;color:#64748b;margin-top:18px">אם לא ביקשתם להיכנס, אפשר להתעלם מההודעה.</p></div>`;
}

export function businessMagicUrl(accountUrl, challengeId, magicToken) {
  const magicUrl = new URL(String(accountUrl));
  magicUrl.searchParams.set('challenge', String(challengeId));
  magicUrl.searchParams.set('token', String(magicToken));
  return magicUrl.toString();
}

export async function requestBusinessLogin(env, req, emailValue, accountUrl) {
  const email = normalizeBusinessEmail(emailValue);
  if (!email) return { ok: false, error: 'invalid_email', status: 400 };

  const ipKey = await anonKey(env, clientIp(req));
  const [byIp, byEmail] = await Promise.all([
    incrRateLimit(env.DB, `bizlogin:ip:${ipKey}`, 15 * 60 * 1000),
    incrRateLimit(env.DB, `bizlogin:email:${await hmacHex(env, 'email', email)}`, 15 * 60 * 1000),
  ]);
  if (byIp.count > 10 || byEmail.count > 3) return { ok: false, error: 'rate_limited', status: 429 };

  const id = randomToken(18);
  const code = genOtp();
  const magicToken = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO business_auth_challenges
      (id, email, code_hash, link_hash, attempts, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`
  ).bind(
    id,
    email,
    await hmacHex(env, 'code', `${id}:${code}`),
    await hmacHex(env, 'link', `${id}:${magicToken}`),
    now + AUTH_TTL_MS,
    now
  ).run();

  const magicUrl = businessMagicUrl(accountUrl, id, magicToken);
  await notifyEmail(env, env.DB, {
    orderId: null,
    template: 'business_login',
    recipient: email,
    subject: 'הכניסה שלך לחשבון העסקי ב-EdenMish',
    html: loginEmailHtml(code, magicUrl),
  });
  return {
    ok: true,
    challenge: id,
    ...(env.TEST_MODE === '1' ? { test_code: code, test_token: magicToken, challenge: id } : {}),
  };
}

async function ensureBusinessIdentity(DB, email) {
  const now = Date.now();
  const user = await DB.prepare(
    `INSERT INTO business_users (email, created_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
     RETURNING id, email, name, phone`
  ).bind(email, now, now).first();
  let membership = await DB.prepare(
    `SELECT m.account_id, m.role, a.company_name, a.plan_id, a.rate_plan_version, a.status
     FROM business_members m JOIN business_accounts a ON a.id = m.account_id
     WHERE m.user_id = ? LIMIT 1`
  ).bind(user.id).first();
  if (!membership) {
    const account = await DB.prepare(
      `INSERT INTO business_accounts (company_name, plan_id, rate_plan_version, status, created_at, updated_at)
       VALUES (NULL, NULL, ?, 'active', ?, ?) RETURNING id`
    ).bind(RATE_PLAN_VERSION, now, now).first();
    await DB.batch([
      DB.prepare(`INSERT OR IGNORE INTO business_members (account_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).bind(account.id, user.id, now),
      DB.prepare(`INSERT OR IGNORE INTO business_wallets (account_id, currency, available_agorot, reserved_agorot, version, updated_at) VALUES (?, 'ILS', 0, 0, 0, ?)`).bind(account.id, now),
    ]);
    membership = { account_id: account.id, role: 'owner', company_name: null, plan_id: null, rate_plan_version: RATE_PLAN_VERSION, status: 'active' };
  }
  return { user, membership };
}

export async function verifyBusinessLogin(env, input) {
  const challengeId = String(input && input.challenge || '').slice(0, 80);
  if (!challengeId) return { ok: false, error: 'invalid_code', status: 401 };
  const challenge = await env.DB.prepare(
    `SELECT id, email, code_hash, link_hash, attempts, expires_at, consumed_at
     FROM business_auth_challenges WHERE id = ?`
  ).bind(challengeId).first();
  const now = Date.now();
  if (!challenge || challenge.consumed_at || challenge.expires_at < now) return { ok: false, error: 'expired', status: 401 };
  if (challenge.attempts >= 5) return { ok: false, error: 'locked', status: 429 };

  let valid = false;
  if (input.token) valid = timingSafeEqual(challenge.link_hash, await hmacHex(env, 'link', `${challenge.id}:${String(input.token)}`));
  else if (/^\d{6}$/.test(String(input.code || ''))) valid = timingSafeEqual(challenge.code_hash, await hmacHex(env, 'code', `${challenge.id}:${String(input.code)}`));

  if (!valid) {
    await env.DB.prepare('UPDATE business_auth_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL').bind(challenge.id).run();
    return { ok: false, error: 'invalid_code', status: 401 };
  }
  const consumed = await env.DB.prepare('UPDATE business_auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').bind(now, challenge.id).run();
  if (!consumed || !consumed.meta || Number(consumed.meta.changes) !== 1) return { ok: false, error: 'invalid_code', status: 401 };

  const identity = await ensureBusinessIdentity(env.DB, challenge.email);
  const rawSession = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO business_sessions (id_hash, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`
  ).bind(await hmacHex(env, 'session', rawSession), identity.user.id, now, now + BUSINESS_SESSION_TTL_MS).run();
  return { ok: true, session: rawSession, account_id: identity.membership.account_id };
}

export function businessSessionCookie(rawSession) {
  return `${BUSINESS_SESSION_COOKIE}=${rawSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(BUSINESS_SESSION_TTL_MS / 1000)}`;
}

export function clearBusinessSessionCookie() {
  return `${BUSINESS_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function getBusinessSession(req, env) {
  const raw = getCookie(req, BUSINESS_SESSION_COOKIE);
  if (!raw) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.user_id, s.expires_at,
            u.email, u.name, u.phone,
            m.account_id, m.role,
            a.company_name, a.plan_id, a.rate_plan_version, a.status,
            w.currency, w.available_agorot, w.reserved_agorot, w.updated_at
     FROM business_sessions s
     JOIN business_users u ON u.id = s.user_id
     JOIN business_members m ON m.user_id = u.id
     JOIN business_accounts a ON a.id = m.account_id
     JOIN business_wallets w ON w.account_id = a.id
     WHERE s.id_hash = ? AND s.revoked_at IS NULL
       AND s.expires_at > ? AND s.created_at >= ? AND a.status = 'active'
     LIMIT 1`
  ).bind(await hmacHex(env, 'session', raw), now, now - BUSINESS_SESSION_TTL_MS).first();
  return row || null;
}

export async function revokeBusinessSession(req, env) {
  const raw = getCookie(req, BUSINESS_SESSION_COOKIE);
  if (!raw) return;
  await env.DB.prepare('UPDATE business_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
    .bind(Date.now(), await hmacHex(env, 'session', raw)).run();
}

export async function updateBusinessProfile(DB, session, input) {
  const has = (key) => Object.prototype.hasOwnProperty.call(input || {}, key);
  const company = has('company_name') ? String(input.company_name || '').trim().slice(0, 160) || null : undefined;
  const name = has('name') ? String(input.name || '').trim().slice(0, 120) || null : undefined;
  const phone = has('phone') ? String(input.phone || '').trim().slice(0, 30) || null : undefined;
  const now = Date.now();
  const statements = [];
  if (company !== undefined) {
    statements.push(DB.prepare('UPDATE business_accounts SET company_name = ?, updated_at = ? WHERE id = ?').bind(company, now, session.account_id));
  }
  const userAssignments = [];
  const userValues = [];
  if (name !== undefined) { userAssignments.push('name = ?'); userValues.push(name); }
  if (phone !== undefined) { userAssignments.push('phone = ?'); userValues.push(phone); }
  if (userAssignments.length) {
    statements.push(DB.prepare(`UPDATE business_users SET ${userAssignments.join(', ')}, updated_at = ? WHERE id = ?`).bind(...userValues, now, session.user_id));
  }
  if (statements.length) await DB.batch(statements);
  return { company_name: company, name, phone };
}

export async function hydrateBusinessProfileFromPayment(DB, accountId, payment) {
  const company = String(payment?.billingCompany || '').trim().slice(0, 160) || null;
  const name = String(payment?.customerName || '').trim().slice(0, 120) || null;
  const phone = String(payment?.customerPhone || '').trim().slice(0, 30) || null;
  const email = normalizeBusinessEmail(payment?.email);
  if (!company && !name && !phone) return { updated: false };

  const now = Date.now();
  await DB.batch([
    DB.prepare(`UPDATE business_accounts
      SET company_name = COALESCE(NULLIF(TRIM(company_name), ''), ?), updated_at = ?
      WHERE id = ?`).bind(company, now, accountId),
    DB.prepare(`UPDATE business_users
      SET name = COALESCE(NULLIF(TRIM(name), ''), ?),
          phone = COALESCE(NULLIF(TRIM(phone), ''), ?),
          updated_at = ?
      WHERE email = ? AND EXISTS (
        SELECT 1 FROM business_members
        WHERE account_id = ? AND user_id = business_users.id
      )`)
      .bind(name, phone, now, email, accountId),
  ]);
  return { updated: true, company_name: company, name, phone };
}

export async function getBusinessSnapshot(DB, session) {
  const now = Date.now();
  await expireWalletCredit(DB, session.account_id, now);
  const [wallet, orders, entries, topups, lots] = await Promise.all([
    DB.prepare('SELECT currency, available_agorot, reserved_agorot, updated_at FROM business_wallets WHERE account_id = ?').bind(session.account_id).first(),
    DB.prepare(`SELECT id, token, status, pickup, dropoff, service, price, payment_status, created_at
                FROM orders WHERE business_account_id = ? ORDER BY id DESC LIMIT 20`).bind(session.account_id).all(),
    DB.prepare(`SELECT entry_type, available_delta_agorot, reserved_delta_agorot, order_id, note, created_at
                FROM wallet_entries WHERE account_id = ? ORDER BY id DESC LIMIT 30`).bind(session.account_id).all(),
    DB.prepare(`SELECT id, plan_id, amount_agorot, payment_amount_agorot, discount_code, discount_amount_agorot, discount_title, status, checkout_url, created_at, paid_at
                FROM wallet_topups WHERE account_id = ? ORDER BY created_at DESC LIMIT 10`).bind(session.account_id).all(),
    DB.prepare(`SELECT remaining_agorot, expires_at FROM wallet_credit_lots
                WHERE account_id = ? AND remaining_agorot > 0 AND expires_at > ?
                ORDER BY expires_at ASC LIMIT 1`).bind(session.account_id, now).first(),
  ]);
  return {
    user: { email: session.email, name: session.name, phone: session.phone, role: session.role },
    account: { id: session.account_id, company_name: session.company_name, plan_id: session.plan_id, rate_plan_version: session.rate_plan_version },
    wallet: {
      currency: wallet && wallet.currency || 'ILS',
      available: Number(wallet && wallet.available_agorot || 0) / 100,
      reserved: Number(wallet && wallet.reserved_agorot || 0) / 100,
      next_expiry: lots ? { amount: Number(lots.remaining_agorot) / 100, at: Number(lots.expires_at) } : null,
      delivery_estimate: estimateBusinessDeliveries(wallet && wallet.available_agorot, session.plan_id),
    },
    orders: orders.results || [],
    entries: (entries.results || []).map((entry) => ({ ...entry, available_delta: entry.available_delta_agorot / 100, reserved_delta: entry.reserved_delta_agorot / 100 })),
    topups: (topups.results || []).map((topup) => ({
      ...topup,
      amount: topup.amount_agorot / 100,
      payment_amount: Number(topup.payment_amount_agorot ?? topup.amount_agorot) / 100,
      discount_amount: Number(topup.discount_amount_agorot || 0) / 100,
    })),
    plans: publicBusinessPlans(),
  };
}

export async function createWalletTopup(DB, session, planId, coupon = null) {
  const plan = BUSINESS_PLANS[planId];
  if (!plan) return null;
  const id = randomToken(22);
  const now = Date.now();
  const paymentAmountAgorot = coupon ? Math.round(Number(coupon.price) * 100) : plan.amount_agorot;
  const discountAmountAgorot = coupon ? Math.round(Number(coupon.discountAmount) * 100) : 0;
  if (plan.one_per_account) {
    await DB.prepare(`UPDATE wallet_topups SET status = 'cancelled'
      WHERE account_id = ? AND plan_id = ? AND status IN ('created','checkout_ready') AND created_at < ?`)
      .bind(session.account_id, plan.id, now - DAY).run();
  }
  const inserted = await DB.prepare(
    `INSERT OR IGNORE INTO wallet_topups
      (id, account_id, plan_id, amount_agorot, payment_amount_agorot, discount_code, discount_amount_agorot, discount_title, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ILS', 'created', ?)
     RETURNING id`
  ).bind(
    id,
    session.account_id,
    plan.id,
    plan.amount_agorot,
    paymentAmountAgorot,
    coupon ? coupon.code : null,
    discountAmountAgorot,
    coupon ? coupon.title : null,
    now,
  ).first();
  if (!inserted) return { error: plan.one_per_account ? 'trial_already_used' : 'topup_unavailable' };
  return {
    id,
    account_id: session.account_id,
    email: session.email,
    company_name: session.company_name,
    plan,
    amount: paymentAmountAgorot / 100,
    subtotal: plan.amount_agorot / 100,
    credit_amount: plan.amount_agorot / 100,
    discount_code: coupon ? coupon.code : null,
    discount_amount: discountAmountAgorot / 100,
    discount_title: coupon ? coupon.title : null,
  };
}

export async function markWalletTopupCheckout(DB, topupId, charge) {
  await DB.prepare(
    `UPDATE wallet_topups SET status = 'checkout_ready', checkout_url = ?, shopify_draft_order_id = ?
     WHERE id = ? AND status = 'created'`
  ).bind(charge.checkoutUrl, String(charge.draftOrderId || charge.processorRef || ''), topupId).run();
}

export async function cancelWalletTopup(DB, topupId) {
  await DB.prepare(`UPDATE wallet_topups SET status = 'cancelled' WHERE id = ? AND status = 'created'`)
    .bind(topupId).run();
}

export async function getWalletTopup(DB, id) {
  return DB.prepare('SELECT * FROM wallet_topups WHERE id = ?').bind(id).first();
}

export async function creditWalletTopup(DB, topup, payment) {
  if (!topup) return { credited: false, reason: 'not_found' };
  const amountAgorot = Math.round(Number(payment.total) * 100);
  const expectedPaymentAgorot = Number(topup.payment_amount_agorot ?? topup.amount_agorot);
  const amountMatches = Number.isSafeInteger(amountAgorot) && amountAgorot === expectedPaymentAgorot;
  const currencyMatches = String(payment.currency || '').toUpperCase() === String(topup.currency || 'ILS').toUpperCase();
  const draftMatches = !topup.shopify_draft_order_id || !payment.draftOrderId || String(topup.shopify_draft_order_id) === String(payment.draftOrderId);
  if (topup.status === 'paid') {
    const orderMatches = topup.shopify_order_id != null
      && payment.shopifyOrderId != null
      && String(topup.shopify_order_id) === String(payment.shopifyOrderId);
    return {
      credited: true,
      unchanged: true,
      paymentValidated: Boolean(payment.paid && amountMatches && currencyMatches && draftMatches && orderMatches),
    };
  }
  if (!payment.paid || !amountMatches || !currencyMatches || !draftMatches) {
    await DB.prepare(`UPDATE wallet_topups SET status = 'mismatch', shopify_order_id = ? WHERE id = ? AND status != 'paid'`)
      .bind(payment.shopifyOrderId == null ? null : String(payment.shopifyOrderId), topup.id).run();
    return { credited: false, reason: 'payment_mismatch' };
  }

  const now = Date.now();
  const expiresAt = now + (BUSINESS_PLANS[topup.plan_id]?.credit_valid_days || 60) * DAY;
  const idempotencyKey = `topup:${topup.id}:paid`;
  const statements = [
    DB.prepare(`UPDATE business_wallets
      SET available_agorot = available_agorot + ?, version = version + 1, updated_at = ?
      WHERE account_id = ? AND EXISTS (SELECT 1 FROM wallet_topups WHERE id = ? AND status != 'paid')`)
      .bind(topup.amount_agorot, now, topup.account_id, topup.id),
    DB.prepare(`INSERT OR IGNORE INTO wallet_credit_lots
      (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
      SELECT account_id, id, amount_agorot, amount_agorot, ?, ? FROM wallet_topups WHERE id = ? AND status != 'paid'`)
      .bind(expiresAt, now, topup.id),
    DB.prepare(`INSERT OR IGNORE INTO wallet_entries
      (account_id, entry_type, available_delta_agorot, reserved_delta_agorot, topup_id, idempotency_key, note, created_at)
      SELECT account_id, 'topup', amount_agorot, 0, id, ?, ?, ? FROM wallet_topups WHERE id = ? AND status != 'paid'`)
      .bind(idempotencyKey, `Shopify order ${payment.shopifyOrderId || ''}`.trim(), now, topup.id),
    DB.prepare(`INSERT OR IGNORE INTO business_plan_enrollments
      (account_id, plan_id, rate_plan_version, topup_id, starts_at, credit_expires_at)
      SELECT account_id, plan_id, ?, id, ?, ? FROM wallet_topups WHERE id = ? AND status != 'paid'`)
      .bind(RATE_PLAN_VERSION, now, expiresAt, topup.id),
    DB.prepare(`UPDATE business_accounts SET plan_id = ?, rate_plan_version = ?, updated_at = ? WHERE id = ?`)
      .bind(topup.plan_id, RATE_PLAN_VERSION, now, topup.account_id),
    DB.prepare(`UPDATE wallet_topups SET status = 'paid', shopify_order_id = ?, paid_at = ? WHERE id = ? AND status != 'paid'`)
      .bind(payment.shopifyOrderId == null ? null : String(payment.shopifyOrderId), now, topup.id),
  ];
  const results = await DB.batch(statements);
  const credited = Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) === 1;
  return { credited, paymentValidated: credited, expires_at: expiresAt };
}

export function shouldHydrateBusinessProfile(creditResult) {
  return Boolean(creditResult?.paymentValidated && !creditResult?.unchanged);
}

export async function expireWalletCredit(DB, accountId, now = Date.now()) {
  const state = await DB.prepare(`SELECT w.available_agorot, w.reserved_agorot,
      COALESCE(SUM(l.remaining_agorot), 0) AS expired_agorot
    FROM business_wallets w
    LEFT JOIN wallet_credit_lots l
      ON l.account_id = w.account_id AND l.expires_at <= ? AND l.remaining_agorot > 0
    WHERE w.account_id = ?
    GROUP BY w.account_id, w.available_agorot, w.reserved_agorot`)
    .bind(now, accountId).first();
  const expiredAgorot = Number(state?.expired_agorot || 0);
  const amountToExpire = Math.max(0, expiredAgorot - Number(state?.reserved_agorot || 0));
  if (amountToExpire === 0) return { expired_agorot: 0 };
  if (Number(state?.available_agorot || 0) < amountToExpire) {
    throw new Error('wallet_expiry_invariant_failed');
  }

  const runKey = `expiry:${accountId}:${now}:${randomToken(8)}`;
  const note = 'Unused wallet credit expired';
  await DB.batch([
    DB.prepare(`WITH expired AS (
        SELECT COALESCE(SUM(remaining_agorot), 0) AS total_agorot
        FROM wallet_credit_lots
        WHERE account_id = ? AND expires_at <= ? AND remaining_agorot > 0
      ), amount AS (
        SELECT MAX(0, expired.total_agorot - w.reserved_agorot) AS value
        FROM business_wallets w CROSS JOIN expired
        WHERE w.account_id = ?
      )
      INSERT INTO wallet_entries
        (account_id, entry_type, available_delta_agorot, reserved_delta_agorot, idempotency_key, note, created_at)
      SELECT ?, 'expiry', -amount.value, 0, ?, ?, ?
      FROM amount JOIN business_wallets w ON w.account_id = ?
      WHERE amount.value > 0 AND w.available_agorot >= amount.value`)
      .bind(accountId, now, accountId, accountId, runKey, note, now, accountId),
    DB.prepare(`UPDATE business_wallets
      SET available_agorot = available_agorot + (
            SELECT available_delta_agorot FROM wallet_entries WHERE idempotency_key = ?
          ),
          version = version + 1,
          updated_at = ?
      WHERE account_id = ?
        AND EXISTS (SELECT 1 FROM wallet_entries WHERE idempotency_key = ?)
        AND available_agorot >= -(
          SELECT available_delta_agorot FROM wallet_entries WHERE idempotency_key = ?
        )`).bind(runKey, now, accountId, runKey, runKey),
    DB.prepare(`WITH ordered AS (
        SELECT l.id, l.remaining_agorot, w.reserved_agorot,
          COALESCE(SUM(l.remaining_agorot) OVER (
            ORDER BY l.expires_at, l.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0) AS before_agorot
        FROM wallet_credit_lots l
        JOIN business_wallets w ON w.account_id = l.account_id
        WHERE l.account_id = ? AND l.expires_at <= ? AND l.remaining_agorot > 0
      ), protected AS (
        SELECT id,
          MIN(remaining_agorot, MAX(0, reserved_agorot - before_agorot)) AS kept_agorot
        FROM ordered
      )
      UPDATE wallet_credit_lots
      SET remaining_agorot = (
        SELECT kept_agorot FROM protected WHERE protected.id = wallet_credit_lots.id
      )
      WHERE id IN (SELECT id FROM protected)
        AND EXISTS (SELECT 1 FROM wallet_entries WHERE idempotency_key = ?)`)
      .bind(accountId, now, runKey),
  ]);
  const entry = await DB.prepare(
    'SELECT available_delta_agorot FROM wallet_entries WHERE idempotency_key = ?'
  ).bind(runKey).first();
  return { expired_agorot: Math.max(0, -Number(entry?.available_delta_agorot || 0)) };
}

export async function reserveWalletCredit(DB, accountId, amountAgorot, idempotencyKey) {
  if (!Number.isSafeInteger(amountAgorot) || amountAgorot <= 0) throw new Error('invalid_wallet_amount');
  const safeKey = String(idempotencyKey || '').trim().slice(0, 120);
  if (!safeKey) throw new Error('idempotency_key_required');
  const existing = await DB.prepare('SELECT * FROM wallet_reservations WHERE account_id = ? AND idempotency_key = ?').bind(accountId, safeKey).first();
  if (existing) return { reserved: existing.status !== 'released', reservation: existing, unchanged: true };

  const id = randomToken(22);
  const now = Date.now();
  await expireWalletCredit(DB, accountId, now);
  try {
    const results = await DB.batch([
      DB.prepare(`INSERT INTO wallet_reservations (id, account_id, idempotency_key, amount_agorot, status, created_at)
        SELECT ?, account_id, ?, ?, 'reserved', ? FROM business_wallets
        WHERE account_id = ? AND available_agorot >= ?`)
        .bind(id, safeKey, amountAgorot, now, accountId, amountAgorot),
      DB.prepare(`UPDATE business_wallets
        SET available_agorot = available_agorot - ?, reserved_agorot = reserved_agorot + ?, version = version + 1, updated_at = ?
        WHERE account_id = ? AND EXISTS (SELECT 1 FROM wallet_reservations WHERE id = ? AND status = 'reserved')`)
        .bind(amountAgorot, amountAgorot, now, accountId, id),
      DB.prepare(`INSERT INTO wallet_entries
        (account_id, entry_type, available_delta_agorot, reserved_delta_agorot, reservation_id, idempotency_key, created_at)
        SELECT account_id, 'reserve', ?, ?, id, ?, ? FROM wallet_reservations WHERE id = ? AND status = 'reserved'`)
        .bind(-amountAgorot, amountAgorot, `reservation:${id}:reserve`, now, id),
    ]);
    if (Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) !== 1) {
      const wallet = await DB.prepare('SELECT available_agorot FROM business_wallets WHERE account_id = ?').bind(accountId).first();
      return { reserved: false, available_agorot: Number(wallet && wallet.available_agorot || 0), shortfall_agorot: Math.max(0, amountAgorot - Number(wallet && wallet.available_agorot || 0)) };
    }
  } catch (error) {
    const raced = await DB.prepare('SELECT * FROM wallet_reservations WHERE account_id = ? AND idempotency_key = ?').bind(accountId, safeKey).first();
    if (raced) return { reserved: raced.status !== 'released', reservation: raced, unchanged: true };
    throw error;
  }
  const reservation = await DB.prepare('SELECT * FROM wallet_reservations WHERE id = ?').bind(id).first();
  return { reserved: true, reservation };
}

export async function linkWalletReservationToOrder(DB, reservationId, orderId) {
  await DB.batch([
    DB.prepare(`UPDATE wallet_reservations SET order_id = ? WHERE id = ? AND order_id IS NULL`).bind(orderId, reservationId),
    DB.prepare(`UPDATE orders SET wallet_reservation_id = ?, payment_method = 'wallet' WHERE id = ?`).bind(reservationId, orderId),
  ]);
}

const consumeLotsSql = `WITH target AS (
  SELECT r.account_id, r.amount_agorot
  FROM wallet_reservations r
  WHERE r.id = ? AND r.status = 'captured' AND r.captured_at = ?
    AND NOT EXISTS (
      SELECT 1 FROM wallet_entries e
      WHERE e.reservation_id = r.id AND e.entry_type = 'capture'
    )
), ordered AS (
  SELECT l.id, l.remaining_agorot, t.amount_agorot,
    COALESCE(SUM(remaining_agorot) OVER (ORDER BY expires_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_amount
  FROM wallet_credit_lots l JOIN target t ON t.account_id = l.account_id
  WHERE l.remaining_agorot > 0
), consumption AS (
  SELECT id, MIN(remaining_agorot, MAX(0, amount_agorot - before_amount)) AS take_amount FROM ordered
)
UPDATE wallet_credit_lots
SET remaining_agorot = remaining_agorot - COALESCE((SELECT take_amount FROM consumption WHERE consumption.id = wallet_credit_lots.id), 0)
WHERE id IN (SELECT id FROM consumption WHERE take_amount > 0)`;

export async function captureWalletReservation(DB, reservationId, orderId = null) {
  const reservation = await DB.prepare('SELECT * FROM wallet_reservations WHERE id = ?').bind(reservationId).first();
  if (!reservation || reservation.status !== 'reserved') return { captured: reservation && reservation.status === 'captured', unchanged: true };
  const now = Date.now();
  const results = await DB.batch([
    DB.prepare(`UPDATE wallet_reservations
      SET status = 'captured', captured_at = ?, order_id = COALESCE(order_id, ?)
      WHERE id = ? AND status = 'reserved'
        AND EXISTS (
          SELECT 1 FROM business_wallets w
          WHERE w.account_id = wallet_reservations.account_id
            AND w.reserved_agorot >= wallet_reservations.amount_agorot
        )
        AND COALESCE((
          SELECT SUM(l.remaining_agorot) FROM wallet_credit_lots l
          WHERE l.account_id = wallet_reservations.account_id AND l.remaining_agorot > 0
        ), 0) >= wallet_reservations.amount_agorot`)
      .bind(now, orderId, reservation.id),
    DB.prepare(`UPDATE business_wallets SET reserved_agorot = reserved_agorot - ?, version = version + 1, updated_at = ?
      WHERE account_id = ? AND reserved_agorot >= ?
        AND EXISTS (
          SELECT 1 FROM wallet_reservations r
          WHERE r.id = ? AND r.status = 'captured' AND r.captured_at = ?
            AND NOT EXISTS (
              SELECT 1 FROM wallet_entries e
              WHERE e.reservation_id = r.id AND e.entry_type = 'capture'
            )
        )`)
      .bind(reservation.amount_agorot, now, reservation.account_id, reservation.amount_agorot, reservation.id, now),
    DB.prepare(consumeLotsSql).bind(reservation.id, now),
    DB.prepare(`INSERT INTO wallet_entries
      (account_id, entry_type, available_delta_agorot, reserved_delta_agorot, reservation_id, order_id, idempotency_key, created_at)
      SELECT account_id, 'capture', 0, -amount_agorot, id, COALESCE(order_id, ?), ?, ?
      FROM wallet_reservations WHERE id = ? AND status = 'captured' AND captured_at = ?`)
      .bind(orderId, `reservation:${reservation.id}:capture`, now, reservation.id, now),
  ]);
  return { captured: Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) === 1 };
}

export async function releaseWalletReservation(DB, reservationId, orderId = null) {
  const reservation = await DB.prepare('SELECT * FROM wallet_reservations WHERE id = ?').bind(reservationId).first();
  if (!reservation || reservation.status !== 'reserved') return { released: reservation && reservation.status === 'released', unchanged: true };
  const now = Date.now();
  const results = await DB.batch([
    DB.prepare(`UPDATE business_wallets
      SET available_agorot = available_agorot + ?, reserved_agorot = reserved_agorot - ?, version = version + 1, updated_at = ?
      WHERE account_id = ? AND reserved_agorot >= ? AND EXISTS (SELECT 1 FROM wallet_reservations WHERE id = ? AND status = 'reserved')`)
      .bind(reservation.amount_agorot, reservation.amount_agorot, now, reservation.account_id, reservation.amount_agorot, reservation.id),
    DB.prepare(`INSERT INTO wallet_entries
      (account_id, entry_type, available_delta_agorot, reserved_delta_agorot, reservation_id, order_id, idempotency_key, created_at)
      SELECT account_id, 'release', amount_agorot, -amount_agorot, id, COALESCE(order_id, ?), ?, ?
      FROM wallet_reservations WHERE id = ? AND status = 'reserved'`)
      .bind(orderId, `reservation:${reservation.id}:release`, now, reservation.id),
    DB.prepare(`UPDATE wallet_reservations SET status = 'released', released_at = ?, order_id = COALESCE(order_id, ?)
      WHERE id = ? AND status = 'reserved'`).bind(now, orderId, reservation.id),
  ]);
  return { released: Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) === 1 };
}

export async function cleanupBusinessSecurity(DB, now = Date.now()) {
  const [challenges, sessions] = await DB.batch([
    DB.prepare('DELETE FROM business_auth_challenges WHERE expires_at < ?').bind(now - DAY),
    DB.prepare('DELETE FROM business_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').bind(now, now - 30 * DAY),
  ]);
  return { challenges, sessions };
}
