// Coupons — D1-managed discount codes, Worker-enforced (migration 008).
//
// Eden creates/edits codes from the ops dashboard. validateCoupon reads the
// definition straight from D1 — no external API call, no sync, no TTL.
// Usage limits are enforced by counting rows in `coupon_redemptions`
// (per code, and per code+customer_key for once-per-customer).
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

// Validate a code against the D1 definition + redemption counts.
// Returns { valid: true, code, title, valueType, value, subtotal, discountAmount, price }
// or { valid: false, reason } with reason one of:
//   'not_found' | 'inactive' | 'not_started' | 'expired' |
//   'usage_limit_reached' | 'already_used'
export async function validateCoupon(db, code, subtotal, customerKey, options = {}) {
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

  const now = Date.now();
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
    const used = await countRedemptions(db, norm, null, scope);
    if (used >= Number(row.usage_limit)) return { valid: false, reason: 'usage_limit_reached' };
  }
  if (row.applies_once_per_customer && customerKey) {
    const usedByCustomer = await countRedemptions(db, norm, customerKey, scope);
    if (usedByCustomer > 0) return { valid: false, reason: 'already_used' };
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
  };
}

// ---- CRUD for the ops dashboard ----

export async function listCoupons(db) {
  const r = await db.prepare(
    `SELECT c.*, COALESCE(cr.redemptions, 0) AS redemption_count,
       COALESCE(br.redemptions, 0) AS business_redemption_count
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
     ORDER BY c.synced_at DESC`
  ).all();
  return (r && r.results) ? r.results.map((row) => ({
    ...row,
    redemption_count: Number(row.redemption_count || 0) + Number(row.business_redemption_count || 0),
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
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO coupons (code, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, scope, business_plan_ids, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
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
  const allowed = ['title', 'value_type', 'value', 'status', 'starts_at', 'ends_at', 'usage_limit', 'applies_once_per_customer', 'scope', 'business_plan_ids'];
  if (fields.value_type !== undefined && fields.value_type !== 'percentage' && fields.value_type !== 'fixed_amount') {
    throw new Error('invalid value_type');
  }
  for (const f of allowed) {
    if (fields[f] !== undefined) {
      sets.push(`${f} = ?`);
      if (f === 'applies_once_per_customer') binds.push(fields[f] ? 1 : 0);
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

export async function deleteCoupon(db, code) {
  const norm = normalizeCode(code);
  const row = await getCoupon(db, norm);
  if (!row) return null;
  await db.prepare('UPDATE coupons SET status = ?, synced_at = ? WHERE code = ?')
    .bind('inactive', Date.now(), norm).run();
  return getCoupon(db, norm);
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
export async function recordRedemption(db, { orderId, code, customerKey, priceBefore, discountAmount, priceAfter, usageLimit = null, oncePerCustomer = false }) {
  const norm = normalizeCode(code);
  const key = customerKey ?? null;
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
