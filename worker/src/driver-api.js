import { anonKey, clientIp } from './security.js';
import { incrRateLimit, resetRateLimit, getOrderById, setOrderStatus } from './db.js';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^(drv|sh|stop)_[A-Za-z0-9]+$/;
const EVENT_TYPES = new Set([
  'route_revision_acknowledged', 'inserted_order_rejected', 'inserted_stop_rejected',
  'navigation_started', 'arrived', 'pickup_completed', 'delivery_completed',
  'delivery_failed',
]);

const response = (body, status = 200, requestId = null, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
    ...extra,
  },
});

async function readJson(req) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid_body'), { status: 400 }); }
}

function metadata(req) {
  const requestId = req.headers.get('x-request-id') || '';
  const installationId = req.headers.get('x-device-installation-id') || '';
  const clientVersion = req.headers.get('x-client-version') || '';
  if (!UUID.test(requestId)) return { error: 'invalid_request_id', requestId: null };
  if (!UUID.test(installationId)) return { error: 'invalid_installation_id', requestId };
  if (!/^\d+\.\d+\.\d+\+\d+$/.test(clientVersion)) return { error: 'invalid_client_version', requestId };
  return { requestId, installationId, clientVersion };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value)));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function constantTimeTextEqual(a, b) {
  const [left, right] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function authenticate(req, env, meta) {
  const authorization = req.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(`SELECT s.driver_id, d.display_name, d.locale
    FROM driver_sessions s JOIN drivers d ON d.id = s.driver_id
    WHERE s.access_token_hash = ? AND s.installation_id = ?
      AND s.revoked_at IS NULL AND s.access_expires_at > ? AND d.active = 1`)
    .bind(tokenHash, meta.installationId, Date.now()).first();
}

async function createSession(req, env, meta) {
  if (!env.DRIVER_ONE_TIME_CODE || !env.SESSION_SECRET) return response({ code: 'driver_auth_unconfigured', message: 'Driver authentication is unavailable.', request_id: meta.requestId }, 503, meta.requestId);
  const rateKey = 'drvlogin:' + await anonKey(env, clientIp(req));
  const rate = await incrRateLimit(env.DB, rateKey, 10 * 60 * 1000);
  if (rate.count > 5) return response({ code: 'rate_limited', message: 'Too many attempts.', request_id: meta.requestId }, 429, meta.requestId, { 'Retry-After': '600' });
  let body;
  try { body = await readJson(req); } catch (error) { return response({ code: error.message, message: 'Invalid request.', request_id: meta.requestId }, error.status || 400, meta.requestId); }
  if (!body || typeof body.one_time_code !== 'string' || !/^\d{6,12}$/.test(body.one_time_code)
    || !(await constantTimeTextEqual(body.one_time_code, env.DRIVER_ONE_TIME_CODE))) {
    return response({ code: 'invalid_credentials', message: 'Invalid credentials.', request_id: meta.requestId }, 401, meta.requestId);
  }
  const now = Date.now();
  const driverId = env.DRIVER_ID || 'drv_eden';
  const displayName = env.DRIVER_DISPLAY_NAME || 'Eden';
  await env.DB.prepare(`INSERT INTO drivers (id, display_name, locale, active, created_at)
    VALUES (?, ?, 'he-IL', 1, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`)
    .bind(driverId, displayName, now).run();
  const codeHash = await hmacHex(env.SESSION_SECRET, `driver-login:${body.one_time_code}`);
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const sessionId = 'ds_' + crypto.randomUUID().replace(/-/g, '');
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO driver_sessions
    (id, driver_id, installation_id, login_code_hash, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    sessionId, driverId, meta.installationId, codeHash, await sha256Hex(accessToken), await sha256Hex(refreshToken),
    now + ACCESS_TTL_MS, now + REFRESH_TTL_MS, now,
  ).run();
  if (!inserted?.meta?.changes) {
    return response({ code: 'invalid_credentials', message: 'Invalid credentials.', request_id: meta.requestId }, 401, meta.requestId);
  }
  await resetRateLimit(env.DB, rateKey);
  return response({
    access_token: accessToken,
    access_token_expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    refresh_token: refreshToken,
    driver: { driver_id: driverId, display_name: displayName, locale: 'he-IL' },
  }, 201, meta.requestId);
}

async function refreshSession(req, env, meta) {
  let body;
  try { body = await readJson(req); } catch (error) { return response({ code: error.message, message: 'Invalid request.', request_id: meta.requestId }, error.status || 400, meta.requestId); }
  if (!body || typeof body.refresh_token !== 'string' || body.refresh_token.length < 32) {
    return response({ code: 'unauthorized', message: 'Driver session is invalid.', request_id: meta.requestId }, 401, meta.requestId);
  }
  const oldRefreshHash = await sha256Hex(body.refresh_token);
  const session = await env.DB.prepare(`SELECT s.id, s.driver_id, d.display_name, d.locale
    FROM driver_sessions s JOIN drivers d ON d.id = s.driver_id
    WHERE s.refresh_token_hash = ? AND s.installation_id = ?
      AND s.revoked_at IS NULL AND s.refresh_expires_at > ? AND d.active = 1`)
    .bind(oldRefreshHash, meta.installationId, Date.now()).first();
  if (!session) return response({ code: 'unauthorized', message: 'Driver session is invalid.', request_id: meta.requestId }, 401, meta.requestId);

  const now = Date.now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const rotated = await env.DB.prepare(`UPDATE driver_sessions
    SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?, refresh_expires_at = ?
    WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`).bind(
    await sha256Hex(accessToken), await sha256Hex(refreshToken), now + ACCESS_TTL_MS, now + REFRESH_TTL_MS,
    session.id, oldRefreshHash,
  ).run();
  if (!rotated?.meta?.changes) return response({ code: 'unauthorized', message: 'Driver session is invalid.', request_id: meta.requestId }, 401, meta.requestId);
  return response({
    access_token: accessToken,
    access_token_expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    refresh_token: refreshToken,
    driver: { driver_id: session.driver_id, display_name: session.display_name, locale: session.locale },
  }, 200, meta.requestId);
}

async function currentShift(env, auth, meta) {
  const shift = await env.DB.prepare(`SELECT id, state, started_at, ended_at, location_expected
    FROM driver_shifts WHERE driver_id = ? AND state IN ('active','ending','recovery_required')
    ORDER BY started_at DESC LIMIT 1`).bind(auth.driver_id).first();
  if (!shift) return response({ code: 'shift_not_found', message: 'No active shift.', request_id: meta.requestId }, 404, meta.requestId);
  return response({ shift_id: shift.id, state: shift.state, started_at: new Date(shift.started_at).toISOString(), ended_at: shift.ended_at ? new Date(shift.ended_at).toISOString() : null, location_expected: !!shift.location_expected }, 200, meta.requestId);
}

function onboardOrderIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((orderId) => {
      if (Number.isInteger(orderId) && orderId > 0) return `ord_${orderId}`;
      if (/^ord_[A-Za-z0-9]+$/.test(orderId || '')) return orderId;
      return null;
    }).filter(Boolean))];
  } catch {
    return [];
  }
}

function routeTask(stop) {
  const taskType = stop.task_type === 'pickup' ? 'pickup' : 'dropoff';
  const isPickup = taskType === 'pickup';
  const displayText = isPickup ? stop.pickup : stop.dropoff;
  const detail = isPickup ? stop.pickup_detail : stop.dropoff_detail;
  return {
    stop_id: stop.stop_id,
    order_id: `ord_${stop.order_id}`,
    position: stop.position,
    task_type: taskType,
    required_predecessor_stop_id: stop.required_predecessor_stop_id || null,
    state: stop.state === 'delivered' ? 'completed' : stop.state,
    contact: { display_name: stop.name, phone: stop.phone },
    address: {
      display_text: [displayText, detail].filter(Boolean).join(' · '),
      latitude: isPickup ? stop.pickup_lat : stop.dropoff_lat,
      longitude: isPickup ? stop.pickup_lng : stop.dropoff_lng,
    },
    promised_window: { from: stop.promised_from, to: stop.promised_to },
    eta: stop.eta,
    service_duration_seconds: Number.isInteger(stop.service_duration_seconds)
      ? stop.service_duration_seconds : 300,
    urgency: stop.urgency,
  };
}

async function routeSnapshot(env, auth, meta, shiftId) {
  if (!ID.test(shiftId)) return response({ code: 'not_found', message: 'Route not found.', request_id: meta.requestId }, 404, meta.requestId);
  const shift = await env.DB.prepare('SELECT id FROM driver_shifts WHERE id = ? AND driver_id = ?').bind(shiftId, auth.driver_id).first();
  if (!shift) return response({ code: 'not_found', message: 'Route not found.', request_id: meta.requestId }, 404, meta.requestId);
  const route = await env.DB.prepare(`SELECT * FROM driver_routes WHERE shift_id = ? ORDER BY revision DESC LIMIT 1`).bind(shiftId).first();
  if (!route) return response({ code: 'route_not_found', message: 'Route not found.', request_id: meta.requestId }, 404, meta.requestId);
  const rows = await env.DB.prepare(`SELECT s.*, o.name, o.phone,
      o.pickup, o.pickup_detail, o.pickup_lat, o.pickup_lng,
      o.dropoff, o.dropoff_detail, o.dropoff_lat, o.dropoff_lng
    FROM driver_route_stops s JOIN orders o ON o.id = s.order_id
    WHERE s.route_id = ? ORDER BY s.position`).bind(route.id).all();
  const stops = (rows.results || []).map(routeTask);
  return response({
    shift_id: shiftId, revision: route.revision, generated_at: new Date(route.generated_at).toISOString(), reason: route.reason,
    current_stop_id: route.current_stop_id, current_stop_locked: !!route.current_stop_locked,
    delay_minutes: route.delay_minutes,
    onboard_order_ids: onboardOrderIds(route.onboard_order_ids_json),
    progress: { current_position: route.current_position, total_stops: route.total_stops }, stops,
    change_summary: { added_stop_ids: (rows.results || []).filter((s) => s.inserted).map((s) => s.stop_id), removed_stop_ids: [], moved_stop_ids: [] },
  }, 200, meta.requestId, { ETag: `"route-${shiftId}-${route.revision}"` });
}

function parseOrderId(value) {
  const match = /^ord_(\d+)$/.exec(value || '');
  return match ? Number(match[1]) : null;
}

async function processEvent(env, auth, meta, event) {
  if (!event || !UUID.test(event.event_id || '')) return { event_id: event?.event_id || '', status: 'rejected_invalid', server_received_at: new Date().toISOString() };
  const existing = await env.DB.prepare(`SELECT event_id, status, conflict_type, server_received_at, correlation_id
    FROM driver_execution_events WHERE event_id = ? AND driver_id = ?`).bind(event.event_id, auth.driver_id).first();
  if (existing) return { event_id: existing.event_id, status: 'duplicate', server_received_at: new Date(existing.server_received_at).toISOString(), conflict_type: existing.conflict_type, correlation_id: existing.correlation_id };
  const occurredAt = Date.parse(event.occurred_at);
  if (!EVENT_TYPES.has(event.event_type)
    || !ID.test(event.shift_id || '')
    || !Number.isInteger(event.route_revision_seen) || event.route_revision_seen < 1
    || !Number.isInteger(event.recorded_at_monotonic_ms) || event.recorded_at_monotonic_ms < 0
    || !Number.isFinite(occurredAt)
    || (event.stop_id != null && !ID.test(event.stop_id))
    || event.payload == null || typeof event.payload !== 'object' || Array.isArray(event.payload)
    || Object.keys(event.payload).length > 10) {
    return { event_id: event.event_id, status: 'rejected_invalid', server_received_at: new Date().toISOString() };
  }
  const shift = await env.DB.prepare('SELECT id FROM driver_shifts WHERE id = ? AND driver_id = ?').bind(event.shift_id, auth.driver_id).first();
  if (!shift) return { event_id: event.event_id, status: 'rejected_auth', server_received_at: new Date().toISOString() };
  const orderId = event.order_id == null ? null : parseOrderId(event.order_id);
  if (event.order_id != null && orderId == null) return { event_id: event.event_id, status: 'rejected_invalid', server_received_at: new Date().toISOString() };
  if (orderId != null) {
    const assignment = await env.DB.prepare('SELECT order_id FROM driver_assignments WHERE driver_id = ? AND shift_id = ? AND order_id = ? AND active = 1').bind(auth.driver_id, event.shift_id, orderId).first();
    if (!assignment) return { event_id: event.event_id, status: 'rejected_auth', server_received_at: new Date().toISOString() };
  }
  let status = 'accepted';
  let conflictType = null;
  if (event.event_type === 'pickup_completed' && orderId != null) {
    const order = await getOrderById(env.DB, orderId);
    if (!order || order.status === 'cancelled') { status = 'accepted_conflict'; conflictType = order ? 'order_cancelled' : 'order_missing'; }
    else if (order.status === 'to_pickup') await setOrderStatus(env.DB, orderId, 'picked_up', { picked_up_at: Date.now() });
    else if (order.status !== 'picked_up') { status = 'accepted_conflict'; conflictType = 'invalid_canonical_state'; }
  }
  if (event.event_type === 'delivery_completed' && orderId != null) {
    const order = await getOrderById(env.DB, orderId);
    if (!order || order.status === 'cancelled') { status = 'accepted_conflict'; conflictType = order ? 'order_cancelled' : 'order_missing'; }
    else if (order.status === 'to_dropoff') await setOrderStatus(env.DB, orderId, 'delivered', { delivered_at: Date.now() });
    else if (order.status !== 'delivered') { status = 'accepted_conflict'; conflictType = 'invalid_canonical_state'; }
  }
  const now = Date.now();
  const correlationId = meta.requestId;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO driver_execution_events
    (event_id, driver_id, shift_id, order_id, stop_id, event_type, occurred_at, route_revision_seen, payload_json, status, conflict_type, server_received_at, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.event_id, auth.driver_id, event.shift_id, orderId, event.stop_id || null, event.event_type, event.occurred_at, event.route_revision_seen, JSON.stringify(event.payload || {}), status, conflictType, now, correlationId).run();
  if (!inserted?.meta?.changes) {
    const replay = await env.DB.prepare(`SELECT event_id, status, conflict_type, server_received_at, correlation_id
      FROM driver_execution_events WHERE event_id = ? AND driver_id = ?`).bind(event.event_id, auth.driver_id).first();
    if (replay) return { event_id: replay.event_id, status: 'duplicate', server_received_at: new Date(replay.server_received_at).toISOString(), conflict_type: replay.conflict_type, correlation_id: replay.correlation_id };
    return { event_id: event.event_id, status: 'retry_later', server_received_at: new Date(now).toISOString(), correlation_id: correlationId };
  }
  return { event_id: event.event_id, status, server_received_at: new Date(now).toISOString(), conflict_type: conflictType, correlation_id: correlationId };
}

async function eventBatch(req, env, auth, meta) {
  let body;
  try { body = await readJson(req); } catch (error) { return response({ code: error.message, message: 'Invalid request.', request_id: meta.requestId }, error.status || 400, meta.requestId); }
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) return response({ code: 'invalid_events', message: 'Expected 1-50 events.', request_id: meta.requestId }, 400, meta.requestId);
  const results = [];
  for (const event of body.events) results.push(await processEvent(env, auth, meta, event));
  return response({ results }, 200, meta.requestId);
}

export async function handleDriverApi(req, env, path = new URL(req.url).pathname) {
  if (!path.startsWith('/api/driver/v1/')) return null;
  const meta = metadata(req);
  if (meta.error) return response({ code: meta.error, message: 'Required request metadata is invalid.', request_id: meta.requestId }, 400, meta.requestId);
  if (path === '/api/driver/v1/session' && req.method === 'POST') return createSession(req, env, meta);
  if (path === '/api/driver/v1/session/refresh' && req.method === 'POST') return refreshSession(req, env, meta);
  const auth = await authenticate(req, env, meta);
  if (!auth) return response({ code: 'unauthorized', message: 'Driver session is invalid.', request_id: meta.requestId }, 401, meta.requestId);
  if (path === '/api/driver/v1/shifts/current' && req.method === 'GET') return currentShift(env, auth, meta);
  const routeMatch = /^\/api\/driver\/v1\/shifts\/([^/]+)\/route$/.exec(path);
  if (routeMatch && req.method === 'GET') return routeSnapshot(env, auth, meta, decodeURIComponent(routeMatch[1]));
  if (path === '/api/driver/v1/execution-events:batch' && req.method === 'POST') return eventBatch(req, env, auth, meta);
  return response({ code: 'not_found', message: 'Driver API endpoint not found.', request_id: meta.requestId }, 404, meta.requestId);
}

export const driverApiTest = { metadata, sha256Hex, hmacHex, parseOrderId };
