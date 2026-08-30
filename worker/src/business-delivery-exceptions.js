function normalizedExternalId(value) {
  const externalId = String(value || '').trim().slice(0, 80);
  return externalId || null;
}

function normalizedService(value) {
  const service = String(value || '').trim().toLowerCase();
  return ['eco', 'standard', 'flash'].includes(service) ? service : null;
}

function normalizedIdempotencyKey(value) {
  const key = String(value || '').trim().slice(0, 120);
  return key || null;
}

function exceptionBindings({ accountId, externalId, zone, service, idempotencyKey, now }) {
  const safeAccountId = Number(accountId);
  const safeZone = Number(zone);
  const safeExternalId = normalizedExternalId(externalId);
  const safeService = normalizedService(service);
  const safeIdempotencyKey = normalizedIdempotencyKey(idempotencyKey);
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (
    !Number.isSafeInteger(safeAccountId)
    || safeAccountId <= 0
    || !safeExternalId
    || ![1, 2, 3].includes(safeZone)
    || !safeService
    || !safeIdempotencyKey
  ) return null;
  return {
    accountId: safeAccountId,
    externalId: safeExternalId,
    zone: safeZone,
    service: safeService,
    idempotencyKey: safeIdempotencyKey,
    now: safeNow,
  };
}

export async function findBusinessDeliveryException(DB, input) {
  const safe = exceptionBindings(input || {});
  if (!safe) return null;
  return DB.prepare(`SELECT * FROM business_delivery_exceptions
    WHERE account_id = ? AND external_id = ? AND zone = ? AND service = ?
      AND expires_at >= ?
      AND (consumed_key IS NULL OR consumed_key = ?)
    LIMIT 1`)
    .bind(
      safe.accountId,
      safe.externalId,
      safe.zone,
      safe.service,
      safe.now,
      safe.idempotencyKey,
    )
    .first();
}

export async function claimBusinessDeliveryException(DB, input) {
  const safe = exceptionBindings(input || {});
  if (!safe) return { claimed: false, exception: null };
  const claimed = await DB.prepare(`UPDATE business_delivery_exceptions
    SET consumed_key = COALESCE(consumed_key, ?),
        consumed_at = COALESCE(consumed_at, ?)
    WHERE account_id = ? AND external_id = ? AND zone = ? AND service = ?
      AND expires_at >= ?
      AND (consumed_key IS NULL OR consumed_key = ?)
    RETURNING *`)
    .bind(
      safe.idempotencyKey,
      safe.now,
      safe.accountId,
      safe.externalId,
      safe.zone,
      safe.service,
      safe.now,
      safe.idempotencyKey,
    )
    .first();
  return {
    claimed: Boolean(claimed),
    exception: claimed || null,
  };
}

export async function attachBusinessDeliveryExceptionToOrder(DB, {
  accountId,
  externalId,
  idempotencyKey,
  orderId,
}) {
  const safeAccountId = Number(accountId);
  const safeOrderId = Number(orderId);
  const safeExternalId = normalizedExternalId(externalId);
  const safeIdempotencyKey = normalizedIdempotencyKey(idempotencyKey);
  if (
    !Number.isSafeInteger(safeAccountId)
    || safeAccountId <= 0
    || !Number.isSafeInteger(safeOrderId)
    || safeOrderId <= 0
    || !safeExternalId
    || !safeIdempotencyKey
  ) return { attached: false };
  const result = await DB.prepare(`UPDATE business_delivery_exceptions
    SET order_id = COALESCE(order_id, ?)
    WHERE account_id = ? AND external_id = ? AND consumed_key = ?
      AND (order_id IS NULL OR order_id = ?)`)
    .bind(safeOrderId, safeAccountId, safeExternalId, safeIdempotencyKey, safeOrderId)
    .run();
  return { attached: Number(result?.meta?.changes || 0) === 1 };
}

export function applyBusinessDeliveryException(quote, planId, exception) {
  const priceAgorot = Number(exception && exception.price_agorot);
  if (
    !quote
    || quote.review !== true
    || !(quote.reasons || []).includes('plan_service_unavailable')
  ) return quote;
  if (!Number.isSafeInteger(priceAgorot) || priceAgorot <= 0) return quote;
  const price = priceAgorot / 100;
  return {
    ...quote,
    price,
    available: true,
    review: false,
    reasons: [],
    plan_id: planId || null,
    exception_applied: true,
    exception_expires_at: Number(exception.expires_at),
    breakdown: {
      ...(quote.breakdown || {}),
      exception_total: price,
      total: price,
    },
  };
}
