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
