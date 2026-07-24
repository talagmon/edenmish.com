// Coupons — D1-managed discount codes, Worker-enforced (migration 008).
//
// Eden creates/edits codes from the ops dashboard. validateCoupon reads the
// definition straight from D1 — no external API call, no sync, no TTL.
// Usage limits are enforced by counting rows in `coupon_redemptions`
// (per code, and per code+customer_key for once-per-customer). Automatic
// first-delivery promotions additionally reserve eligibility in
// `first_delivery_promotion_claims` before any order or wallet mutation.
//
// Money units match pricing.js: integer whole shekels (ILS). Percentages are
// stored 0-100. The discount applies to the FULL computed price (incl.
// surcharges) and the final price is clamped so it is never negative
// (a free order — price 0 — is allowed).

// Normalized uppercase everywhere: D1 rows, redemptions, order snapshots.
export function normalizeCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

const BUSINESS_PLAN_IDS = new Set(['trial', 'wallet', 'silver', 'gold', 'platinum']);

function normalizeScope(scope) {
  return scope === 'business_plan' ? 'business_plan' : 'delivery';
}

function identityParts(identity) {
  if (identity && typeof identity === 'object') {
    const businessAccountId = Number(identity.businessAccountId);
    const phoneKey = identity.phoneKey ? String(identity.phoneKey).trim() : null;
    const emailKey = identity.emailKey ? String(identity.emailKey).trim().toLowerCase() : null;
    return {
      customerKey: identity.customerKey || (Number.isSafeInteger(businessAccountId) && businessAccountId > 0 ? `business:${businessAccountId}` : phoneKey || emailKey || null),
      phoneKey,
      emailKey,
      businessAccountId: Number.isSafeInteger(businessAccountId) && businessAccountId > 0 ? businessAccountId : null,
      customerType: identity.customerType === 'business' ? 'business' : 'private',
    };
  }
  return {
    customerKey: identity || null,
    phoneKey: null,
    emailKey: null,
    businessAccountId: null,
    customerType: 'private',
  };
}

export function normalizeBusinessPlanIds(value) {
  let values = value;
  if (typeof values === 'string') {
    try { values = JSON.parse(values); } catch { values = values.split(','); }
  }
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((id) => String(id).trim().toLowerCase()).filter((id) => BUSINESS_PLAN_IDS.has(id)))];
}

// Integer discount amount (ILS), clamped to [0, subtotal].
// percentage  → Math.round(subtotal * value / 100)
// fixed_amount → min(value, subtotal)
export function computeDiscount(coupon, subtotal) {
  const sub = Math.max(0, Math.round(Number(subtotal) || 0));
  const value = Number(coupon && coupon.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const type = coupon && (coupon.value_type || coupon.valueType);
  let amount = 0;
  if (type === 'percentage') amount = Math.round(sub * value / 100);
  else if (type === 'fixed_amount') amount = Math.round(value);
  return Math.min(Math.max(0, amount), sub);
}

async function getCoupon(db, code) {
  return db.prepare('SELECT * FROM coupons WHERE code = ?').bind(code).first();
}

async function countRedemptions(db, code, customerKey, scope = 'delivery') {
  const table = normalizeScope(scope) === 'business_plan' ? 'business_coupon_redemptions' : 'coupon_redemptions';
  let r;
  if (customerKey != null) {
    r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE code = ? AND customer_key = ?`)
      .bind(code, customerKey).first();
  } else {
    r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE code = ?`)
      .bind(code).first();
  }
  return (r && Number(r.n)) || 0;
}

async function countFirstDeliveryClaims(db, couponCode) {
  const r = await db.prepare(
    'SELECT COUNT(*) AS n FROM first_delivery_promotion_claims WHERE coupon_code = ?'
  ).bind(couponCode).first();
  return (r && Number(r.n)) || 0;
}

function paidDeliveryIdentityWhere(identity, binds) {
  const customer = identityParts(identity);
  const matches = [];
  if (customer.phoneKey) {
    matches.push('phone = ?');
    binds.push(customer.phoneKey);
  }
  if (customer.emailKey) {
    matches.push('LOWER(email) = ?');
    binds.push(customer.emailKey);
  }
  if (customer.businessAccountId) {
    matches.push('business_account_id = ?');
    binds.push(customer.businessAccountId);
  }
  return matches;
}

async function hasPriorPaidDelivery(db, identity) {
  const binds = [];
  const matches = paidDeliveryIdentityWhere(identity, binds);
  if (!matches.length) return false;
  const row = await db.prepare(
    `SELECT id FROM orders
     WHERE LOWER(COALESCE(payment_status, '')) IN
       ('paid', 'paid_manual', 'wallet_paid', 'wallet-paid', 'wallet_reserved')
       AND (${matches.join(' OR ')})
     LIMIT 1`
  ).bind(...binds).first();
  return !!row;
}

async function hasFirstDeliveryClaim(db, identity, options = {}) {
  const customer = identityParts(identity);
  if (customer.businessAccountId && options.idempotencyKey) {
    const own = await db.prepare(
      `SELECT id FROM first_delivery_promotion_claims
       WHERE business_account_id = ? AND idempotency_key = ?
       LIMIT 1`
    ).bind(customer.businessAccountId, String(options.idempotencyKey)).first();
    if (own) return false;
  }
  const matches = [];
  const binds = [];
  if (customer.phoneKey) {
    matches.push('phone_key = ?');
    binds.push(customer.phoneKey);
  }
  if (customer.emailKey) {
    matches.push('email_key = ?');
    binds.push(customer.emailKey);
  }
  if (customer.businessAccountId) {
    matches.push('business_account_id = ?');
    binds.push(customer.businessAccountId);
  }
  if (!matches.length) return false;
  const row = await db.prepare(
    `SELECT id FROM first_delivery_promotion_claims
     WHERE ${matches.join(' OR ')}
     LIMIT 1`
  ).bind(...binds).first();
  return !!row;
}

// Validate a code against the D1 definition + redemption counts.
// Returns { valid: true, code, title, valueType, value, subtotal, discountAmount, price }
// or { valid: false, reason } with reason one of:
//   'not_found' | 'inactive' | 'not_started' | 'expired' |
//   'usage_limit_reached' | 'already_used'
export async function validateCoupon(db, code, subtotal, identity, options = {}) {
  const norm = normalizeCode(code);
  if (!norm) return { valid: false, reason: 'not_found' };

  const row = await getCoupon(db, norm);
  if (!row) return { valid: false, reason: 'not_found' };

  const scope = normalizeScope(options.scope);
  if (normalizeScope(row.scope) !== scope) return { valid: false, reason: 'not_applicable' };
  const businessPlanIds = normalizeBusinessPlanIds(row.business_plan_ids);
  if (scope === 'business_plan' && businessPlanIds.length && !businessPlanIds.includes(String(options.planId || ''))) {
    return { valid: false, reason: 'not_applicable' };
  }

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const status = String(row.status || '').toLowerCase();
  if (row.starts_at != null && now < Number(row.starts_at)) return { valid: false, reason: 'not_started' };
  if (row.ends_at != null && now > Number(row.ends_at)) return { valid: false, reason: 'expired' };
  if (status === 'expired') return { valid: false, reason: 'expired' };
  if (status === 'scheduled') return { valid: false, reason: 'not_started' };
  if (status !== 'active') return { valid: false, reason: 'inactive' };
  if (row.value_type !== 'percentage' && row.value_type !== 'fixed_amount') {
    return { valid: false, reason: 'unsupported' };
  }

  if (row.usage_limit != null) {
    const used = row.eligibility_rule === 'first_delivery'
      ? await countFirstDeliveryClaims(db, norm)
      : await countRedemptions(db, norm, null, scope);
    if (used >= Number(row.usage_limit)) return { valid: false, reason: 'usage_limit_reached' };
  }
  const customer = identityParts(identity);
  if (row.applies_once_per_customer && customer.customerKey) {
    const usedByCustomer = await countRedemptions(db, norm, customer.customerKey, scope);
    if (usedByCustomer > 0) return { valid: false, reason: 'already_used' };
  }

  const eligibilityRule = row.eligibility_rule || null;
  if (eligibilityRule === 'first_delivery') {
    if (scope !== 'delivery') return { valid: false, reason: 'not_applicable' };
    if (!customer.phoneKey || !customer.emailKey) return { valid: false, reason: 'identity_required' };
    if (customer.customerType === 'business' && !customer.businessAccountId) {
      return { valid: false, reason: 'identity_required' };
    }
    if (await hasPriorPaidDelivery(db, customer)) return { valid: false, reason: 'not_new_customer' };
    if (await hasFirstDeliveryClaim(db, customer, options)) return { valid: false, reason: 'already_used' };
  } else if (eligibilityRule) {
    return { valid: false, reason: 'unsupported' };
  }

  // priceOrder already returns integer shekels — this rounding is defense-in-depth only.
  const sub = Math.max(0, Math.round(Number(subtotal) || 0));
  const discountAmount = computeDiscount(row, sub);
  return {
    valid: true,
    code: norm,
    title: row.title || null,
    valueType: row.value_type,
    value: Number(row.value),
    subtotal: sub,
    discountAmount,
    price: sub - discountAmount,
    usageLimit: row.usage_limit != null ? Number(row.usage_limit) : null,
    appliesOncePerCustomer: !!row.applies_once_per_customer,
    autoApply: !!row.auto_apply,
    eligibilityRule,
  };
}

// Select the best currently-valid automatic delivery promotion. The definition
// and eligibility remain D1-driven; no coupon code is hard-coded in runtime.
export async function findAutomaticCoupon(db, subtotal, identity, options = {}) {
  const r = await db.prepare(
    `SELECT * FROM coupons
     WHERE auto_apply = 1
     ORDER BY synced_at DESC, code ASC`
  ).all();
  let best = null;
  for (const row of (r && r.results) || []) {
    const candidate = await validateCoupon(db, row.code, subtotal, identity, { ...options, scope: 'delivery' });
    if (candidate.valid && (!best || candidate.discountAmount > best.discountAmount)) best = candidate;
  }
  return best || { valid: false, reason: 'not_eligible' };
}

// ---- CRUD for the ops dashboard ----

export async function listCoupons(db) {
  const r = await db.prepare(
    `SELECT c.*, COALESCE(cr.redemptions, 0) AS redemption_count,
       COALESCE(br.redemptions, 0) AS business_redemption_count,
       COALESCE(pc.claims, 0) AS first_delivery_claim_count
     FROM coupons c
     LEFT JOIN (
       SELECT code, COUNT(*) AS redemptions
       FROM coupon_redemptions
       GROUP BY code
     ) cr ON cr.code = c.code
     LEFT JOIN (
       SELECT code, COUNT(*) AS redemptions
       FROM business_coupon_redemptions
       GROUP BY code
     ) br ON br.code = c.code
     LEFT JOIN (
       SELECT coupon_code, COUNT(*) AS claims
       FROM first_delivery_promotion_claims
       GROUP BY coupon_code
     ) pc ON pc.coupon_code = c.code
     ORDER BY c.synced_at DESC`
  ).all();
  return (r && r.results) ? r.results.map((row) => ({
    ...row,
    redemption_count: row.eligibility_rule === 'first_delivery'
      ? Number(row.first_delivery_claim_count || 0)
      : Number(row.redemption_count || 0) + Number(row.business_redemption_count || 0),
    business_plan_ids: normalizeBusinessPlanIds(row.business_plan_ids),
  })) : [];
}

export async function createCoupon(db, fields) {
  const code = normalizeCode(fields.code);
  if (!code) throw new Error('missing code');
  if (!fields.value_type || (fields.value_type !== 'percentage' && fields.value_type !== 'fixed_amount')) {
    throw new Error('invalid value_type');
  }
  const existing = await getCoupon(db, code);
  if (existing) throw new Error('coupon_exists');
  const value = Number(fields.value);
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid value');
  validateCouponDefinition(fields);
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO coupons (code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, scope, business_plan_ids, auto_apply, eligibility_rule, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      code,
      String(fields.title || '').trim() || null,
      fields.value_type,
      value,
      fields.status || 'active',
      fields.starts_at ? Number(fields.starts_at) : null,
      fields.ends_at ? Number(fields.ends_at) : null,
      fields.usage_limit ? Number(fields.usage_limit) : null,
      fields.applies_once_per_customer ? 1 : 0,
      normalizeScope(fields.scope),
      normalizeBusinessPlanIds(fields.business_plan_ids).length ? JSON.stringify(normalizeBusinessPlanIds(fields.business_plan_ids)) : null,
      fields.auto_apply ? 1 : 0,
      fields.eligibility_rule || null,
      now
    ).run();
  } catch (e) {
    if (e && e.message && /UNIQUE|unique constraint/i.test(e.message)) {
      throw new Error('coupon_exists');
    }
    throw e;
  }
  return getCoupon(db, code);
}

export async function updateCoupon(db, code, fields) {
  const norm = normalizeCode(code);
  const row = await getCoupon(db, norm);
  if (!row) return null;
  const sets = [];
  const binds = [];
  const allowed = ['title', 'value_type', 'value', 'status', 'starts_at', 'ends_at', 'usage_limit', 'applies_once_per_customer', 'scope', 'business_plan_ids', 'auto_apply', 'eligibility_rule'];
  if (fields.value_type !== undefined && fields.value_type !== 'percentage' && fields.value_type !== 'fixed_amount') {
    throw new Error('invalid value_type');
  }
  validateCouponDefinition({ ...row, ...fields });
  for (const f of allowed) {
    if (fields[f] !== undefined) {
      sets.push(`${f} = ?`);
      if (f === 'applies_once_per_customer' || f === 'auto_apply') binds.push(fields[f] ? 1 : 0);
      else if (f === 'scope') binds.push(normalizeScope(fields[f]));
      else if (f === 'business_plan_ids') {
        const planIds = normalizeBusinessPlanIds(fields[f]);
        binds.push(planIds.length ? JSON.stringify(planIds) : null);
      }
      else if (f === 'starts_at' || f === 'ends_at' || f === 'usage_limit') binds.push(fields[f] != null ? Number(fields[f]) : null);
      else binds.push(fields[f]);
    }
  }
  if (!sets.length) return row;
  sets.push('synced_at = ?');
  binds.push(Date.now());
  binds.push(norm);
  await db.prepare(`UPDATE coupons SET ${sets.join(', ')} WHERE code = ?`).bind(...binds).run();
  return getCoupon(db, norm);
}

function validateCouponDefinition(fields) {
  const eligibility = fields.eligibility_rule || null;
  const scope = normalizeScope(fields.scope);
  if (eligibility && eligibility !== 'first_delivery') throw new Error('invalid eligibility_rule');
  if (fields.starts_at != null && fields.ends_at != null && Number(fields.starts_at) > Number(fields.ends_at)) {
    throw new Error('invalid date window');
  }
  if (eligibility === 'first_delivery') {
    if (scope !== 'delivery') throw new Error('first_delivery requires delivery scope');
    if (!fields.applies_once_per_customer) throw new Error('first_delivery requires once per customer');
    if (fields.ends_at == null || !Number.isFinite(Number(fields.ends_at))) {
      throw new Error('first_delivery requires an end date');
    }
  }
  if (fields.auto_apply && eligibility !== 'first_delivery') {
    throw new Error('automatic coupons require first_delivery eligibility');
  }
}

export async function deleteCoupon(db, code) {
  const norm = normalizeCode(code);
  const row = await getCoupon(db, norm);
  if (!row) return null;
  await db.prepare('UPDATE coupons SET status = ?, synced_at = ? WHERE code = ?')
    .bind('inactive', Date.now(), norm).run();
  return getCoupon(db, norm);
}

// Reserve first-delivery eligibility before creating an order or touching a
// business wallet. One INSERT checks paid history and existing claims, while
// partial unique indexes serialize concurrent requests by phone, email, and
// authenticated business account. A repeated business idempotency key reuses
// its own claim.
export async function reserveFirstDeliveryClaim(db, {
  coupon,
  identity,
  idempotencyKey = null,
  now = Date.now(),
}) {
  if (!coupon || coupon.eligibilityRule !== 'first_delivery') return { reserved: false, reason: 'not_applicable' };
  const customer = identityParts(identity);
  if (!customer.phoneKey || !customer.emailKey || (customer.customerType === 'business' && !customer.businessAccountId)) {
    return { reserved: false, reason: 'identity_required' };
  }

  if (customer.businessAccountId && idempotencyKey) {
    const existing = await db.prepare(
      `SELECT * FROM first_delivery_promotion_claims
       WHERE business_account_id = ? AND idempotency_key = ?`
    ).bind(customer.businessAccountId, String(idempotencyKey)).first();
    if (existing) return { reserved: true, claim: existing, unchanged: true };
  }

  const identityMatches = [];
  const identityBinds = [];
  if (customer.phoneKey) {
    identityMatches.push('phone_key = ?');
    identityBinds.push(customer.phoneKey);
  }
  if (customer.emailKey) {
    identityMatches.push('email_key = ?');
    identityBinds.push(customer.emailKey);
  }
  if (customer.businessAccountId) {
    identityMatches.push('business_account_id = ?');
    identityBinds.push(customer.businessAccountId);
  }

  const paidBinds = [];
  const paidMatches = paidDeliveryIdentityWhere(customer, paidBinds);
  const usageLimit = coupon.usageLimit != null ? Number(coupon.usageLimit) : null;
  const values = [
    coupon.code,
    customer.customerKey,
    customer.phoneKey,
    customer.emailKey,
    customer.businessAccountId,
    idempotencyKey ? String(idempotencyKey) : null,
    Number(now),
    Number(now),
  ];
  const guards = [
    `EXISTS (
      SELECT 1 FROM coupons
      WHERE code = ? AND eligibility_rule = 'first_delivery'
        AND status = 'active'
        AND (starts_at IS NULL OR starts_at <= ?)
        AND (ends_at IS NULL OR ends_at >= ?)
    )`,
    `NOT EXISTS (
      SELECT 1 FROM orders
      WHERE LOWER(COALESCE(payment_status, '')) IN
        ('paid', 'paid_manual', 'wallet_paid', 'wallet-paid', 'wallet_reserved')
        AND (${paidMatches.join(' OR ')})
    )`,
    `NOT EXISTS (
      SELECT 1 FROM first_delivery_promotion_claims
      WHERE ${identityMatches.join(' OR ')}
    )`,
  ];
  const guardBinds = [coupon.code, Number(now), Number(now), ...paidBinds, ...identityBinds];
  if (Number.isFinite(usageLimit)) {
    guards.push(
      `(SELECT COUNT(*) FROM first_delivery_promotion_claims WHERE coupon_code = ?) < ?`
    );
    guardBinds.push(coupon.code, usageLimit);
  }

  try {
    const claim = await db.prepare(
      `INSERT INTO first_delivery_promotion_claims
        (coupon_code, customer_key, phone_key, email_key, business_account_id,
         idempotency_key, status, created_at, updated_at)
       SELECT ?,?,?,?,?,?,'reserved',?,?
       WHERE ${guards.join(' AND ')}
       RETURNING *`
    ).bind(...values, ...guardBinds).first();
    if (claim) return { reserved: true, claim, unchanged: false };
  } catch (error) {
    if (!/UNIQUE/i.test(String(error && error.message || error))) throw error;
  }

  if (customer.businessAccountId && idempotencyKey) {
    const existing = await db.prepare(
      `SELECT * FROM first_delivery_promotion_claims
       WHERE business_account_id = ? AND idempotency_key = ?`
    ).bind(customer.businessAccountId, String(idempotencyKey)).first();
    if (existing) return { reserved: true, claim: existing, unchanged: true };
  }
  return { reserved: false, reason: 'not_new_customer' };
}

export async function attachFirstDeliveryClaim(db, claimId, orderId) {
  const r = await db.prepare(
    `UPDATE first_delivery_promotion_claims
     SET order_id = ?, status = 'redeemed', updated_at = ?
     WHERE id = ? AND (order_id IS NULL OR order_id = ?)`
  ).bind(orderId, Date.now(), claimId, orderId).run();
  const changes = r && r.meta ? Number(r.meta.changes) : Number(r && r.changes);
  return { attached: changes === 1 };
}

export async function releaseFirstDeliveryClaim(db, claimId) {
  if (!claimId) return;
  await db.prepare(
    'DELETE FROM first_delivery_promotion_claims WHERE id = ? AND order_id IS NULL'
  ).bind(claimId).run();
}

// One row per successful redemption; usage limits count these rows.
//
// TOCTOU guard: validateCoupon's count check and this insert are separate D1
// statements, so two concurrent orders could both pass validation and exceed the
// limit. When the coupon has a usage_limit (and/or is once-per-customer with a
// known customerKey) the INSERT is made conditional — `INSERT ... SELECT ...
// WHERE <count guards>` runs atomically in a single statement, so the row only
// lands if the limits still hold at insert time.
// Returns { recorded: boolean }; recorded === false means the guard rejected it
// (a concurrent redemption won the race). Coupons with no limits skip the guard
// entirely (plain unconditional insert).
export async function recordRedemption(db, {
  orderId,
  code,
  customerKey,
  priceBefore,
  discountAmount,
  priceAfter,
  usageLimit = null,
  oncePerCustomer = false,
  promotionClaimId = null,
}) {
  const norm = normalizeCode(code);
  const key = customerKey ?? null;
  if (promotionClaimId) {
    try {
      await db.prepare(
        `INSERT INTO coupon_redemptions
          (order_id, code, customer_key, price_before, discount_amount, price_after, created_at, promotion_claim_id)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(orderId, norm, key, priceBefore ?? null, discountAmount ?? null, priceAfter ?? null, Date.now(), promotionClaimId).run();
      return { recorded: true };
    } catch (error) {
      if (/UNIQUE/i.test(String(error && error.message || error))) return { recorded: true, unchanged: true };
      throw error;
    }
  }
  const values = [orderId, norm, key, priceBefore ?? null, discountAmount ?? null, priceAfter ?? null, Date.now()];
  const hasLimit = usageLimit != null && Number.isFinite(Number(usageLimit));
  const hasCustomerGuard = !!(oncePerCustomer && key);
  if (!hasLimit && !hasCustomerGuard) {
    await db.prepare(
      `INSERT INTO coupon_redemptions (order_id, code, customer_key, price_before, discount_amount, price_after, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(...values).run();
    return { recorded: true };
  }
  const guards = [];
  const binds = [...values];
  if (hasLimit) {
    guards.push('(SELECT COUNT(*) FROM coupon_redemptions WHERE code = ?) < ?');
    binds.push(norm, Number(usageLimit));
  }
  if (hasCustomerGuard) {
    guards.push('(SELECT COUNT(*) FROM coupon_redemptions WHERE code = ? AND customer_key = ?) = 0');
    binds.push(norm, key);
  }
  const r = await db.prepare(
    `INSERT INTO coupon_redemptions (order_id, code, customer_key, price_before, discount_amount, price_after, created_at)
     SELECT ?,?,?,?,?,?,?
     WHERE ${guards.join(' AND ')}`
  ).bind(...binds).run();
  const changes = r && r.meta ? Number(r.meta.changes) : Number(r && r.changes);
  return { recorded: changes === 1 };
}

// Business-plan coupons are reserved when the top-up checkout is created. They
// use a separate table because delivery redemptions require an orders.id, while
// plan purchases are correlated by wallet_topups.id.
export async function recordBusinessRedemption(db, { topupId, code, customerKey, priceBefore, discountAmount, priceAfter, usageLimit = null, oncePerCustomer = false }) {
  const norm = normalizeCode(code);
  const key = customerKey ?? null;
  const values = [topupId, norm, key, priceBefore ?? null, discountAmount ?? null, priceAfter ?? null, Date.now()];
  const hasLimit = usageLimit != null && Number.isFinite(Number(usageLimit));
  const hasCustomerGuard = !!(oncePerCustomer && key);
  if (!hasLimit && !hasCustomerGuard) {
    await db.prepare(
      `INSERT INTO business_coupon_redemptions (topup_id, code, customer_key, price_before, discount_amount, price_after, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(...values).run();
    return { recorded: true };
  }
  const guards = [];
  const binds = [...values];
  if (hasLimit) {
    guards.push('(SELECT COUNT(*) FROM business_coupon_redemptions WHERE code = ?) < ?');
    binds.push(norm, Number(usageLimit));
  }
  if (hasCustomerGuard) {
    guards.push('(SELECT COUNT(*) FROM business_coupon_redemptions WHERE code = ? AND customer_key = ?) = 0');
    binds.push(norm, key);
  }
  const r = await db.prepare(
    `INSERT INTO business_coupon_redemptions (topup_id, code, customer_key, price_before, discount_amount, price_after, created_at)
     SELECT ?,?,?,?,?,?,?
     WHERE ${guards.join(' AND ')}`
  ).bind(...binds).run();
  const changes = r && r.meta ? Number(r.meta.changes) : Number(r && r.changes);
  return { recorded: changes === 1 };
}

export async function releaseBusinessRedemption(db, topupId) {
  await db.prepare('DELETE FROM business_coupon_redemptions WHERE topup_id = ?').bind(topupId).run();
}
