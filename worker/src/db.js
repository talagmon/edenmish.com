// D1 data access helpers

export async function createOrder(DB, o) {
  const now = Date.now();
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 22);
  const r = await DB.prepare(
    `INSERT INTO orders (
       token, status, name, phone, customer_type,
       pickup, pickup_detail, pickup_lat, pickup_lng, pickup_city,
       dropoff, dropoff_detail, dropoff_lat, dropoff_lng, dropoff_city,
       when_text, package, urgent, notes, distance_km,
       price, currency, review_flag, review_reason, payment_url, payment_status, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     RETURNING id, token`
  ).bind(
    token, o.status ?? 'received', o.name ?? null, o.phone ?? null, o.customer_type ?? null,
    o.pickup ?? null, o.pickup_detail ?? null, o.pickup_lat ?? null, o.pickup_lng ?? null, o.pickup_city ?? null,
    o.dropoff ?? null, o.dropoff_detail ?? null, o.dropoff_lat ?? null, o.dropoff_lng ?? null, o.dropoff_city ?? null,
    o.when_text ?? null, o.package ?? null, o.urgent ? 1 : 0, o.notes ?? null, o.distance_km ?? null,
    o.price ?? null, 'ILS', o.review_flag ? 1 : 0, o.review_reason ?? null, o.payment_url ?? null, o.payment_status ?? 'none', now
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
  return DB.prepare(`SELECT * FROM orders WHERE token = ?`).bind(token).first();
}
export async function getOrderById(DB, id) {
  return DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first();
}

export async function listOrders(DB, limit = 100) {
  return DB.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`).bind(limit).all();
}

export async function getStatusHistory(DB, orderId) {
  return DB.prepare(`SELECT status, at, note FROM status_history WHERE order_id = ? ORDER BY at ASC`).bind(orderId).all();
}

export async function addGps(DB, orderId, lat, lng) {
  await DB.prepare(`INSERT INTO gps_pings (order_id, lat, lng, at) VALUES (?,?,?,?)`).bind(orderId, lat, lng, Date.now()).run();
}
export async function latestGps(DB, orderId) {
  return DB.prepare(`SELECT lat, lng, at FROM gps_pings WHERE order_id = ? ORDER BY at DESC LIMIT 1`).bind(orderId).first();
}

export async function recordPayment(DB, orderId, p) {
  await DB.prepare(
    `INSERT INTO payments (order_id, amount, currency, payplus_id, status, url, created_at, paid_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(orderId, p.amount, 'ILS', p.payplus_id || null, p.status || 'created', p.url || null, Date.now(), p.paid_at || null).run();
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
  return DB.prepare('SELECT count, window_start, last_at, locked_until FROM rate_limits WHERE key = ?').bind(key).first();
}

// Increment the counter for a window. If the window has elapsed (windowMs), the
// counter resets to 1. Returns the post-increment state (lastAt = now).
export async function incrRateLimit(DB, key, windowMs) {
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
}

// Set / extend a lockout on a key without resetting the counter.
export async function setRateLock(DB, key, lockedUntil) {
  const now = Date.now();
  await DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start, last_at, locked_until) VALUES (?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET locked_until = excluded.locked_until, last_at = excluded.last_at`
  ).bind(key, 0, now, now, lockedUntil).run();
}

export async function resetRateLimit(DB, key) {
  await DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

// ---- proof of delivery (PR7) ----
// One row per order (order_id UNIQUE). upserted when Eden marks delivered.

export async function getDeliveryProof(DB, orderId) {
  return DB.prepare('SELECT receiver_name, delivery_note, photo_url, created_at, updated_at FROM delivery_proofs WHERE order_id = ?').bind(orderId).first();
}

export async function upsertDeliveryProof(DB, orderId, p) {
  const now = Date.now();
  const existing = await DB.prepare('SELECT order_id FROM delivery_proofs WHERE order_id = ?').bind(orderId).first();
  if (existing) {
    await DB.prepare('UPDATE delivery_proofs SET receiver_name = ?, delivery_note = ?, photo_url = ?, updated_at = ? WHERE order_id = ?')
      .bind(p.receiver_name ?? null, p.delivery_note ?? null, p.photo_url ?? null, now, orderId).run();
  } else {
    await DB.prepare('INSERT INTO delivery_proofs (order_id, receiver_name, delivery_note, photo_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(orderId, p.receiver_name ?? null, p.delivery_note ?? null, p.photo_url ?? null, now, now).run();
  }
  return getDeliveryProof(DB, orderId);
}
