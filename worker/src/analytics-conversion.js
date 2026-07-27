const CLAIM_RE = /^[a-f0-9]{32}$/;
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function validAnalyticsClaim(value) {
  return CLAIM_RE.test(String(value || ''));
}

export async function hashAnalyticsClaim(value) {
  if (!validAnalyticsClaim(value)) return null;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`edenmish-paid-conversion-v1:${value}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function registerAnalyticsClaim(DB, orderId, rawClaim, now = Date.now()) {
  const claimHash = await hashAnalyticsClaim(rawClaim);
  if (!claimHash || !Number.isSafeInteger(Number(orderId)) || Number(orderId) <= 0) return false;
  const result = await DB.prepare(`INSERT OR IGNORE INTO analytics_conversion_claims
    (claim_hash, order_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)`)
    .bind(claimHash, Number(orderId), now, now + CLAIM_TTL_MS)
    .run();
  return !!result?.meta?.changes;
}

export async function observeAnalyticsClaim(DB, rawClaim, eligible, now = Date.now()) {
  const claimHash = await hashAnalyticsClaim(rawClaim);
  if (!claimHash) return { status: 'unavailable' };

  if (!eligible) {
    const suppressed = await DB.prepare(`UPDATE analytics_conversion_claims
      SET disposition = 'suppressed', observed_at = ?
      WHERE claim_hash = ? AND observed_at IS NULL`)
      .bind(now, claimHash)
      .run();
    return { status: suppressed?.meta?.changes ? 'suppressed' : 'unavailable' };
  }

  const emitted = await DB.prepare(`UPDATE analytics_conversion_claims
    SET disposition = 'emitted', observed_at = ?
    WHERE claim_hash = ? AND observed_at IS NULL AND settled_at IS NOT NULL
      AND expires_at > ?
      AND EXISTS (
        SELECT 1
        FROM orders o
        WHERE o.id = analytics_conversion_claims.order_id
          AND o.payment_status = 'paid'
          AND o.shopify_order_id IS NOT NULL
          AND COALESCE(o.payment_method, '') != 'wallet'
          AND EXISTS (
            SELECT 1 FROM payments p
            WHERE p.order_id = o.id AND p.status = 'paid'
          )
      )
    RETURNING order_id`)
    .bind(now, claimHash, now)
    .first();

  if (emitted?.order_id) {
    const conversion = await DB.prepare(`SELECT o.price AS value, o.currency
      FROM orders o
      JOIN analytics_conversion_claims c ON c.order_id = o.id
      WHERE c.order_id = ? AND c.disposition = 'emitted' AND c.observed_at = ?`)
      .bind(emitted.order_id, now)
      .first();
    if (conversion) {
      return {
        status: 'emitted',
        event: 'paid_order',
        value: Number(conversion.value),
        currency: String(conversion.currency || 'ILS').toUpperCase(),
      };
    }
  }

  const ineligible = await DB.prepare(`UPDATE analytics_conversion_claims
    SET disposition = 'suppressed', observed_at = ?
    WHERE claim_hash = ? AND observed_at IS NULL AND settled_at IS NOT NULL`)
    .bind(now, claimHash)
    .run();
  if (ineligible?.meta?.changes) return { status: 'suppressed' };

  const pending = await DB.prepare(`SELECT 1 AS pending
    FROM analytics_conversion_claims
    WHERE claim_hash = ? AND observed_at IS NULL AND settled_at IS NULL
      AND expires_at > ?`)
    .bind(claimHash, now)
    .first();
  return { status: pending ? 'pending' : 'unavailable' };
}

export async function cleanupAnalyticsClaims(DB, now = Date.now()) {
  return DB.prepare(`DELETE FROM analytics_conversion_claims
    WHERE expires_at <= ?
      OR (observed_at IS NOT NULL AND observed_at <= ?)`)
    .bind(now, now - CLAIM_RETENTION_MS)
    .run();
}

export const __analyticsConversionTest = {
  CLAIM_TTL_MS,
  CLAIM_RETENTION_MS,
};
