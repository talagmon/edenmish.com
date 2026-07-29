// D1 data access helpers

export async function createOrder(DB, o) {
  const now = Date.now();
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 22);
  const r = await DB.prepare(
    `INSERT INTO orders (
       token, status, name, phone, customer_type,
       pickup, pickup_detail, pickup_lat, pickup_lng, pickup_city,
       dropoff, dropoff_detail, dropoff_lat, dropoff_lng, dropoff_city,
       when_text, when_date, when_hour, service, size, package, urgent, notes, distance_km,
       price, currency, review_flag, review_reason, payment_url, payment_status, created_at,
       subtotal_price, discount_code, discount_amount, discount_title,
       business_account_id, business_external_id, wallet_reservation_id, payment_method,
       phone_delivery_link_opt_in, phone_delivery_link_opt_in_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     RETURNING id, token`
  ).bind(
    token, o.status ?? 'received', o.name ?? null, o.phone ?? null, o.customer_type ?? null,
    o.pickup ?? null, o.pickup_detail ?? null, o.pickup_lat ?? null, o.pickup_lng ?? null, o.pickup_city ?? null,
    o.dropoff ?? null, o.dropoff_detail ?? null, o.dropoff_lat ?? null, o.dropoff_lng ?? null, o.dropoff_city ?? null,
    o.when_text ?? null, o.when_date ?? null, o.when_hour ?? null,
    o.service ?? null, o.size ?? null, o.package ?? null, o.urgent ? 1 : 0, o.notes ?? null, o.distance_km ?? null,
    o.price ?? null, 'ILS', o.review_flag ? 1 : 0, o.review_reason ?? null, o.payment_url ?? null, o.payment_status ?? 'none', now,
    // Coupon snapshot (migration 008): NULL/0 when no coupon — identical to the old row shape.
    o.subtotal_price ?? null, o.discount_code ?? null, o.discount_amount ?? 0, o.discount_title ?? null,
    o.business_account_id ?? null, o.business_external_id ?? null, o.wallet_reservation_id ?? null, o.payment_method ?? null,
    o.phone_delivery_link_opt_in ? 1 : 0, o.phone_delivery_link_opt_in_at ?? null
  ).first();
  await addStatus(DB, r.id, o.status || 'received');
  return r; // { id, token }
}

export async function addStatus(DB, orderId, status, note = null) {
  await DB.prepare(
    `INSERT INTO status_history (order_id, status, at, note) VALUES (?,?,?,?)`
  ).bind(orderId, status, Date.now(), note).run();
}

export async function setOrderStatus(DB, orderId, status, fields = {}) {
  const sets = ['status = ?'];
  const vals = [status];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(orderId);
  await DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  await addStatus(DB, orderId, status);
}

export async function getOrderByToken(DB, token) {
  return DB.prepare(`SELECT * FROM orders WHERE LOWER(token) = LOWER(?)`).bind(token).first();
}
export async function getOrderById(DB, id) {
  return DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first();
}
export async function getOrderByWalletReservationId(DB, reservationId) {
  return DB.prepare(`SELECT * FROM orders WHERE wallet_reservation_id = ?`).bind(reservationId).first();
}
export async function getOrderByShopifyOrderId(DB, shopifyOrderId) {
  return DB.prepare(`SELECT * FROM orders WHERE shopify_order_id = ?`).bind(shopifyOrderId).first();
}
// Customer delivery rating (1-5) submitted from v2 delivered.html. Token-gated.
export async function setOrderRating(DB, orderId, rating) {
  await DB.prepare(`UPDATE orders SET rating = ? WHERE id = ?`).bind(rating, orderId).run();
}

export async function listOrders(DB, limit = 500) {
  return DB.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`).bind(limit).all();
}

export async function getStatusHistory(DB, orderId) {
  return DB.prepare(`SELECT status, at, note FROM status_history WHERE order_id = ? ORDER BY at ASC`).bind(orderId).all();
}

export async function addGps(DB, orderId, lat, lng) {
  await DB.prepare(`INSERT INTO gps_pings (order_id, lat, lng, at) VALUES (?,?,?,?)`).bind(orderId, lat, lng, Date.now()).run();
  // Bound per-order storage. One thousand five-second samples preserve roughly
  // 83 minutes of full-resolution history without allowing indefinite D1 growth.
  await DB.prepare(`DELETE FROM gps_pings
    WHERE order_id = ? AND id NOT IN (
      SELECT id FROM gps_pings WHERE order_id = ? ORDER BY at DESC LIMIT 1000
    )`).bind(orderId, orderId).run();
}
export async function latestGps(DB, orderId) {
  return DB.prepare(`SELECT lat, lng, at FROM gps_pings WHERE order_id = ? ORDER BY at DESC LIMIT 1`).bind(orderId).first();
}
export async function getGpsTrail(DB, orderId, limit = 500) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const r = await DB.prepare(`SELECT lat, lng, at FROM (
    SELECT lat, lng, at FROM gps_pings WHERE order_id = ? ORDER BY at DESC LIMIT ?
  ) ORDER BY at ASC`).bind(orderId, safeLimit).all();
  return r.results || [];
}

export async function recordPayment(DB, orderId, p) {
  await DB.prepare(
    `INSERT INTO payments (order_id, amount, currency, payplus_id, status, url, created_at, paid_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(orderId, p.amount, 'ILS', p.payplus_id || null, p.status || 'created', p.url || null, Date.now(), p.paid_at || null).run();
}

export async function getRedeliveryChargeByOrderId(DB, orderId) {
  return DB.prepare('SELECT * FROM redelivery_charges WHERE order_id = ?')
    .bind(orderId).first();
}

export async function getRedeliveryChargeById(DB, id) {
  return DB.prepare('SELECT * FROM redelivery_charges WHERE id = ?')
    .bind(id).first();
}

export async function getRedeliveryChargeByShopifyOrderId(DB, shopifyOrderId) {
  return DB.prepare('SELECT * FROM redelivery_charges WHERE shopify_order_id = ?')
    .bind(String(shopifyOrderId)).first();
}

export async function listRedeliveryCharges(DB) {
  return DB.prepare(`SELECT id, order_id, amount_agorot, currency, status,
    payment_url, expires_at, paid_at, released_at
    FROM redelivery_charges
    WHERE status != 'expired'
    ORDER BY updated_at DESC
    LIMIT 500`).all();
}

export async function createRedeliveryCharge(DB, {
  id,
  orderId,
  amountAgorot,
  addressSnapshotJson,
  now = Date.now(),
  expiresAt,
}) {
  await DB.prepare(`INSERT OR IGNORE INTO redelivery_charges
    (id, order_id, amount_agorot, currency, address_snapshot_json,
     status, created_at, updated_at, expires_at)
    SELECT ?, id, ?, 'ILS', ?, 'pending', ?, ?, ?
    FROM orders
    WHERE id = ?
      AND status = 'failed'
      AND retained_by_driver = 'hold_for_redelivery'
      AND pending_redelivery_json = ?`)
    .bind(
      id,
      amountAgorot,
      addressSnapshotJson,
      now,
      now,
      expiresAt,
      orderId,
      addressSnapshotJson,
    ).run();
  const charge = await getRedeliveryChargeByOrderId(DB, orderId);
  return charge?.address_snapshot_json === addressSnapshotJson ? charge : null;
}

export async function getRules(DB) {
  const rows = await DB.prepare(`SELECT name, value FROM pricing_rules`).all();
  const m = {};
  for (const r of rows.results || []) m[r.name] = Number(r.value);
  return m;
}

export async function setEmailAndOtp(DB, id, email, otpHash, otpExpires) {
  await DB.prepare(`UPDATE orders SET email = ?, email_verified = 0, otp_hash = ?, otp_expires = ? WHERE id = ?`)
    .bind(email || null, otpHash, otpExpires, id).run();
}
export async function verifyOtp(DB, id) {
  await DB.prepare(`UPDATE orders SET email_verified = 1, otp_hash = NULL, otp_expires = NULL WHERE id = ?`).bind(id).run();
}

// ---- generic rate limiting (rate_limits table) ----
// Used for OTP attempt lockout, OTP resend throttle, and per-IP order-creation limits.
// Each "key" is a composite string scoped to its purpose, e.g. 'otpv:<token>'.

export async function getRateLimit(DB, key) {
  try {
    return await DB.prepare('SELECT count, window_start, last_at, locked_until FROM rate_limits WHERE key = ?').bind(key).first();
  } catch (e) { console.error('rl_get_err', e && e.message || String(e)); return null; }
}

// Increment the counter for a window. If the window has elapsed (windowMs), the
// counter resets to 1. Returns the post-increment state (lastAt = now).
// Best-effort: returns safe defaults on D1 error (never throws).
export async function incrRateLimit(DB, key, windowMs) {
  try {
    const now = Date.now();
    const r = await DB.prepare('SELECT count, window_start, last_at, locked_until FROM rate_limits WHERE key = ?').bind(key).first();
    let count, windowStart;
    if (!r || !r.window_start || now - r.window_start > windowMs) {
      count = 1; windowStart = now;
    } else {
      count = (r.count || 0) + 1; windowStart = r.window_start;
    }
    const lockedUntil = r ? r.locked_until : null;
    await DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start, last_at, locked_until) VALUES (?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, last_at = excluded.last_at, locked_until = excluded.locked_until`
    ).bind(key, count, windowStart, now, lockedUntil).run();
    return { count, windowStart, lastAt: now, lockedUntil };
  } catch (e) { console.error('rl_incr_err', e && e.message || String(e)); return { count: 0, windowStart: Date.now(), lastAt: 0, lockedUntil: null }; }
}

// Set / extend a lockout on a key without resetting the counter.
export async function setRateLock(DB, key, lockedUntil) {
  try {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start, last_at, locked_until) VALUES (?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET locked_until = excluded.locked_until, last_at = excluded.last_at`
    ).bind(key, 0, now, now, lockedUntil).run();
  } catch (e) { console.error('rl_lock_err', e && e.message || String(e)); }
}

export async function resetRateLimit(DB, key) {
  try {
    await DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
  } catch (e) { console.error('rl_reset_err', e && e.message || String(e)); }
}

// ---- proof of delivery (PR7) ----
// One row per order (order_id UNIQUE). upserted when Eden marks delivered.

export async function getDeliveryProof(DB, orderId) {
  return DB.prepare('SELECT receiver_name, delivery_note, photo_url, signature, created_at, updated_at FROM delivery_proofs WHERE order_id = ?').bind(orderId).first();
}

export async function upsertDeliveryProof(DB, orderId, p) {
  const now = Date.now();
  const existing = await DB.prepare('SELECT order_id FROM delivery_proofs WHERE order_id = ?').bind(orderId).first();
  if (existing) {
    await DB.prepare('UPDATE delivery_proofs SET receiver_name = ?, delivery_note = ?, photo_url = ?, signature = ?, updated_at = ? WHERE order_id = ?')
      .bind(p.receiver_name ?? null, p.delivery_note ?? null, p.photo_url ?? null, p.signature ?? null, now, orderId).run();
  } else {
    await DB.prepare('INSERT INTO delivery_proofs (order_id, receiver_name, delivery_note, photo_url, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(orderId, p.receiver_name ?? null, p.delivery_note ?? null, p.photo_url ?? null, p.signature ?? null, now, now).run();
  }
  return getDeliveryProof(DB, orderId);
}

// ---- notification audit trail (PR8) ----
// NOTE: never store the email body/html or OTP codes here — only metadata + outcome.

function sanitizeError(e) {
  let s = e && e.message ? e.message : String(e == null ? '' : e);
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

export async function createNotificationAttempt(DB, data) {
  const now = Date.now();
  const r = await DB.prepare(
    `INSERT INTO notifications (order_id, channel, template, recipient, subject, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    data.order_id ?? null,
    data.channel || 'email',
    data.template ?? null,
    data.recipient ?? null,
    data.subject ?? null,
    data.status || 'pending',
    now,
    now
  ).first();
  return r ? r.id : null;
}

export async function markNotificationSent(DB, id, providerRef, providerStatus = null) {
  const now = Date.now();
  await DB.prepare(`UPDATE notifications
    SET status = ?, provider_ref = ?, provider_status = ?,
        provider_updated_at = ?, updated_at = ?
    WHERE id = ?`)
    .bind(
      'sent',
      providerRef ?? null,
      providerStatus ?? null,
      null,
      now,
      id,
    ).run();
}

export async function markNotificationFailed(DB, id, error) {
  await DB.prepare('UPDATE notifications SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .bind('failed', sanitizeError(error), Date.now(), id).run();
}

export async function markNotificationSkipped(DB, id) {
  await DB.prepare('UPDATE notifications SET status = ?, updated_at = ? WHERE id = ?')
    .bind('skipped', Date.now(), id).run();
}

export async function listRecentNotificationFailures(DB, limit = 5) {
  return DB.prepare('SELECT id, order_id, channel, template, recipient, subject, error, created_at FROM notifications WHERE status = ? ORDER BY id DESC LIMIT ?')
    .bind('failed', limit).all();
}

export async function listNotificationsForOrder(DB, orderId) {
  return DB.prepare(`SELECT id, channel, template, recipient, subject, status,
      provider_ref, provider_status, provider_updated_at, error, created_at
    FROM notifications WHERE order_id = ? ORDER BY id ASC`)
    .bind(orderId).all();
}

// ---- inbound online cancellation notices ----
// Full identity numbers are never persisted; callers pass only the last 4 digits.
export async function createCancellationRequest(DB, data) {
  const r = await DB.prepare(
    `INSERT INTO cancellation_requests
      (order_number, customer_name, identity_last4, email, phone, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'received', ?) RETURNING id, created_at`
  ).bind(
    data.order_number,
    data.customer_name,
    data.identity_last4,
    data.email ?? null,
    data.phone ?? null,
    data.reason ?? null,
    Date.now()
  ).first();
  return r;
}

export async function listCancellationRequests(DB, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return DB.prepare(
    `SELECT id, order_number, customer_name, identity_last4, email, phone, reason, status, created_at, processed_at
     FROM cancellation_requests ORDER BY created_at DESC LIMIT ?`
  ).bind(safeLimit).all();
}

// Data-minimization schedule. Core order/payment records remain available for
// accounting and legal claims; short-lived operational and security data does not.
// A package held for redelivery reverts to a return once it has waited too long without a
// corrected destination, so it is never carried around indefinitely waiting on an address or
// a fee that never comes. Returns are dispatched without a payment gate, so this always
// resolves the package rather than leaving it stuck. return_to_origin is left untouched — it
// is already resolving.
export async function runHeldPackageAutoReturn(DB, now = Date.now(), maxHoldMs = 24 * 60 * 60 * 1000) {
  const cutoff = now - maxHoldMs;
  const expireCharges = DB.prepare(
    `UPDATE redelivery_charges
     SET status = 'expired', updated_at = ?
     WHERE status IN ('pending', 'creating', 'link_sent')
       AND order_id IN (
         SELECT id FROM orders
         WHERE status = 'failed'
           AND retained_by_driver = 'hold_for_redelivery'
           AND retained_at IS NOT NULL
           AND retained_at < ?
       )`
  ).bind(now, cutoff);
  const returnOrders = DB.prepare(
    `UPDATE orders SET retained_by_driver = 'return_to_origin', retained_at = ?
     WHERE status = 'failed'
       AND retained_by_driver = 'hold_for_redelivery'
       AND retained_at IS NOT NULL
       AND retained_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM redelivery_charges
         WHERE order_id = orders.id AND status IN ('paid', 'released')
       )`
  ).bind(now, cutoff);
  const results = await DB.batch([expireCharges, returnOrders]);
  return results[1];
}

export async function runRetentionCleanup(DB, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const results = {};
  results.gps = await DB.prepare('DELETE FROM gps_pings WHERE at < ?').bind(now - 30 * day).run();
  results.proofs = await DB.prepare(
    `UPDATE delivery_proofs SET photo_url = NULL, signature = NULL
     WHERE updated_at < ? AND (photo_url IS NOT NULL OR signature IS NOT NULL)`
  ).bind(now - 90 * day).run();
  results.notifications = await DB.prepare('DELETE FROM notifications WHERE created_at < ?').bind(now - 365 * day).run();
  results.cancellations = await DB.prepare('DELETE FROM cancellation_requests WHERE created_at < ?').bind(now - 365 * day).run();
  results.rateLimits = await DB.prepare(
    'DELETE FROM rate_limits WHERE last_at < ? AND (locked_until IS NULL OR locked_until < ?)'
  ).bind(now - 2 * day, now).run();
  return results;
}
