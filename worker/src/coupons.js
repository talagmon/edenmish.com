// Coupons — Shopify-defined discount codes, Worker-enforced (migration 008).
//
// Codes are created/edited in Shopify Admin. The Worker syncs each code's
// definition into the `coupons` D1 table (TTL-based, stale-while-error) and
// validates + applies the discount server-side. Usage limits are enforced by
// counting rows in `coupon_redemptions` (per code, and per code+customer_key
// for once-per-customer).
//
// Money units match pricing.js: integer whole shekels (ILS). Percentages are
// stored 0-100. The discount applies to the FULL computed price (incl.
// surcharges) and the final price is clamped so it is never negative
// (a free order — price 0 — is allowed).

import { fetchShopifyDiscountByCode } from './integrations.js';

// How long a synced Shopify definition stays fresh before we re-fetch it.
const SYNC_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Normalized uppercase everywhere: D1 rows, redemptions, order snapshots.
export function normalizeCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
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

async function upsertCoupon(db, c) {
  await db.prepare(
    `INSERT INTO coupons (code, shopify_discount_id, title, value_type, value, status, starts_at, ends_at, usage_limit, applies_once_per_customer, synced_at, raw_shopify_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       shopify_discount_id = excluded.shopify_discount_id,
       title = excluded.title,
       value_type = excluded.value_type,
       value = excluded.value,
       status = excluded.status,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       usage_limit = excluded.usage_limit,
       applies_once_per_customer = excluded.applies_once_per_customer,
       synced_at = excluded.synced_at,
       raw_shopify_json = excluded.raw_shopify_json`
  ).bind(
    c.code, c.shopify_discount_id ?? null, c.title ?? null, c.value_type ?? null, c.value ?? null,
    c.status ?? null, c.starts_at ?? null, c.ends_at ?? null, c.usage_limit ?? null,
    c.applies_once_per_customer ? 1 : 0, c.synced_at, c.raw_shopify_json ?? null
  ).run();
}

async function countRedemptions(db, code, customerKey) {
  let r;
  if (customerKey != null) {
    r = await db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE code = ? AND customer_key = ?')
      .bind(code, customerKey).first();
  } else {
    r = await db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE code = ?')
      .bind(code).first();
  }
  return (r && Number(r.n)) || 0;
}

// Validate a code against the Shopify-synced definition + D1 redemption counts.
// Returns { valid: true, code, title, valueType, value, subtotal, discountAmount, price }
// or { valid: false, reason } with reason one of:
//   'not_found' | 'inactive' | 'not_started' | 'expired' |
//   'usage_limit_reached' | 'already_used' | 'unsupported'
export async function validateCoupon(db, env, code, subtotal, customerKey) {
  const norm = normalizeCode(code);
  if (!norm) return { valid: false, reason: 'not_found' };

  let row = await getCoupon(db, norm);
  const stale = !row || !row.synced_at || Date.now() - row.synced_at > SYNC_TTL_MS;
  if (stale) {
    try {
      const fetched = await fetchShopifyDiscountByCode(env, norm);
      if (fetched && fetched.unsupported) return { valid: false, reason: 'unsupported' };
      if (!fetched) return { valid: false, reason: 'not_found' }; // Shopify: no such code
      row = { ...fetched, code: norm, synced_at: Date.now() };
      await upsertCoupon(db, row);
    } catch {
      // Shopify unreachable/misconfigured → stale-while-error on the cached row,
      // but not forever: beyond 2× the sync TTL the definition is too old to trust
      // (Eden may have disabled/edited the code in Shopify since).
      if (!row) return { valid: false, reason: 'not_found' };
      if (!row.synced_at || Date.now() - Number(row.synced_at) > 2 * SYNC_TTL_MS) {
        return { valid: false, reason: 'not_found' };
      }
    }
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
    const used = await countRedemptions(db, norm);
    if (used >= Number(row.usage_limit)) return { valid: false, reason: 'usage_limit_reached' };
  }
  if (row.applies_once_per_customer && customerKey) {
    const usedByCustomer = await countRedemptions(db, norm, customerKey);
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
    price: sub - discountAmount, // never negative — computeDiscount clamps to subtotal
    // Limits ride along so recordRedemption can apply its atomic usage guard.
    usageLimit: row.usage_limit != null ? Number(row.usage_limit) : null,
    appliesOncePerCustomer: !!row.applies_once_per_customer,
  };
}

// One row per successful redemption; usage limits count these rows.
//
// TOCTOU guard: validateCoupon's count check and this insert are separate D1
// statements, so two concurrent orders could both pass validation and exceed a
// Shopify-defined limit. When the coupon has a usage_limit (and/or is
// once-per-customer with a known customerKey) the INSERT is made conditional —
// `INSERT ... SELECT ... WHERE <count guards>` runs atomically in a single
// statement, so the row only lands if the limits still hold at insert time.
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
