import { anonKey, clientIp } from './security.js';
import {
  incrRateLimit,
  resetRateLimit,
  getOrderById,
  setOrderStatus,
  upsertDeliveryProof,
} from './db.js';
import { syncDriverRoute } from './driver-dispatch.js';
import { runDeliveryCompletionSideEffects } from './delivery-completion.js';
import {
  deliveryCompletionTransitionStatement,
  deliveryNotificationOutboxStatements,
} from './delivery-notification-outbox.js';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOCATION_BATCH_SIZE = 100;
const LOCATION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const LOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_VERSION = /^\d+\.\d+\.\d+\+\d+(?: \([0-9a-f]{7,40}\))?$/i;
const ID = /^(drv|sh|stop)_[A-Za-z0-9]+$/;
const EVENT_TYPES = new Set([
  'route_revision_acknowledged', 'inserted_order_rejected', 'inserted_stop_rejected',
  'navigation_started', 'arrived', 'pickup_completed', 'delivery_completed',
  'delivery_failed',
]);
const TASK_EVENT_TYPES = new Set([
  'navigation_started', 'arrived', 'pickup_completed',
  'delivery_completed', 'delivery_failed',
]);
const TASK_STATE_FOR_EVENT = {
  navigation_started: 'navigating',
  arrived: 'arrived',
  pickup_completed: 'completed',
  delivery_completed: 'completed',
  delivery_failed: 'failed',
};
// What the driver did with the package on a failed delivery. return_to_origin and
// hold_for_redelivery mean the driver still carries it and dispatch owes a return or
// redelivery leg; left_with_alternate means it was handed off.
//
// The field is optional on purpose: the stable Flutter client predates it and reports
// failures without it, and rejecting those would break failure reporting for the
// production app (rejected_invalid is non-retryable). Absent keeps the legacy
// behaviour. A value we do not recognise is a contract defect and is refused, so the
// dispatch layer can trust any value that is stored.
const DELIVERY_FAILURE_DISPOSITIONS = new Set([
  'return_to_origin', 'hold_for_redelivery', 'left_with_alternate',
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

async function readJson(req, maxBodyBytes = MAX_BODY_BYTES) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBodyBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBodyBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid_body'), { status: 400 }); }
}

function metadata(req) {
  const requestId = req.headers.get('x-request-id') || '';
  const installationId = req.headers.get('x-device-installation-id') || '';
  const clientVersion = req.headers.get('x-client-version') || '';
  if (!UUID.test(requestId)) return { error: 'invalid_request_id', requestId: null };
  if (!UUID.test(installationId)) return { error: 'invalid_installation_id', requestId };
  if (!CLIENT_VERSION.test(clientVersion)) return { error: 'invalid_client_version', requestId };
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

function routeTask(stop, executionState = null) {
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
    state: executionState || (stop.state === 'delivered' ? 'completed' : stop.state),
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
  if (env.AUTO_DRIVER_DISPATCH === 'on') {
    const dispatch = await syncDriverRoute(env, { driverId: auth.driver_id, shiftId });
    if (dispatch.empty) {
      return response({ code: 'route_not_found', message: 'No active route tasks.', request_id: meta.requestId }, 404, meta.requestId);
    }
  }
  const route = await env.DB.prepare(`SELECT * FROM driver_routes WHERE shift_id = ? ORDER BY revision DESC LIMIT 1`).bind(shiftId).first();
  if (!route) return response({ code: 'route_not_found', message: 'Route not found.', request_id: meta.requestId }, 404, meta.requestId);
  const rows = await env.DB.prepare(`SELECT s.*, o.name, o.phone,
      o.pickup, o.pickup_detail, o.pickup_lat, o.pickup_lng,
      o.dropoff, o.dropoff_detail, o.dropoff_lat, o.dropoff_lng
    FROM driver_route_stops s JOIN orders o ON o.id = s.order_id
    WHERE s.route_id = ? ORDER BY s.position`).bind(route.id).all();
  const executionRows = await env.DB.prepare(`SELECT stop_id, event_type
    FROM driver_execution_events
    WHERE shift_id = ? AND status = 'accepted'
      AND event_type IN ('navigation_started','arrived','pickup_completed','delivery_completed','delivery_failed')
    ORDER BY server_received_at, event_id`).bind(shiftId).all();
  const executionStateByStop = new Map();
  for (const event of executionRows.results || []) {
    if (event.stop_id && TASK_STATE_FOR_EVENT[event.event_type]) {
      executionStateByStop.set(event.stop_id, TASK_STATE_FOR_EVENT[event.event_type]);
    }
  }
  const stops = (rows.results || []).map((stop) => routeTask(stop, executionStateByStop.get(stop.stop_id)));
  const activeStop = stops.find((stop) => !['completed', 'failed', 'cancelled', 'skipped_by_dispatch'].includes(stop.state));
  return response({
    shift_id: shiftId, revision: route.revision, generated_at: new Date(route.generated_at).toISOString(), reason: route.reason,
    current_stop_id: activeStop?.stop_id || route.current_stop_id,
    current_stop_locked: !!activeStop && ['navigating', 'arrived'].includes(activeStop.state),
    delay_minutes: route.delay_minutes,
    onboard_order_ids: onboardOrderIds(route.onboard_order_ids_json),
    progress: { current_position: activeStop?.position || route.total_stops, total_stops: route.total_stops }, stops,
    change_summary: { added_stop_ids: (rows.results || []).filter((s) => s.inserted).map((s) => s.stop_id), removed_stop_ids: [], moved_stop_ids: [] },
  }, 200, meta.requestId, { ETag: `"route-${shiftId}-${route.revision}"` });
}

function parseOrderId(value) {
  const match = /^ord_(\d+)$/.exec(value || '');
  return match ? Number(match[1]) : null;
}

async function assignedTask(env, shiftId, stopId, orderId) {
  return env.DB.prepare(`SELECT s.stop_id, s.task_type
    FROM driver_route_stops s JOIN driver_routes r ON r.id = s.route_id
    WHERE r.shift_id = ? AND s.stop_id = ? AND s.order_id = ?
    ORDER BY r.revision DESC LIMIT 1`).bind(shiftId, stopId, orderId).first();
}

function validProofData(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.order_id != null && parseOrderId(body.order_id) == null) return false;
  if (body.signer_name != null && (typeof body.signer_name !== 'string' || body.signer_name.length > 120)) return false;
  if (body.note != null && (typeof body.note !== 'string' || body.note.length > 1000)) return false;
  if (body.photo_data_url != null && (
    typeof body.photo_data_url !== 'string'
    || !body.photo_data_url.startsWith('data:image/jpeg;base64,')
    || body.photo_data_url.length > 1_500_000
  )) return false;
  if (body.signature_data_url != null && (
    typeof body.signature_data_url !== 'string'
    || !body.signature_data_url.startsWith('data:image/png;base64,')
    || body.signature_data_url.length > 500_000
  )) return false;
  return !!(body.photo_data_url || body.signature_data_url);
}

async function taskProof(req, env, auth, meta, shiftId, stopId) {
  if (!ID.test(shiftId) || !ID.test(stopId)) {
    return response({ code: 'not_found', message: 'Route task not found.', request_id: meta.requestId }, 404, meta.requestId);
  }
  let body;
  try { body = await readJson(req, 2_100_000); } catch (error) {
    return response({ code: error.message, message: 'Invalid proof.', request_id: meta.requestId }, error.status || 400, meta.requestId);
  }
  if (!validProofData(body)) {
    return response({ code: 'invalid_proof', message: 'A valid photo or signature is required.', request_id: meta.requestId }, 400, meta.requestId);
  }
  const shift = await env.DB.prepare(`SELECT id FROM driver_shifts
    WHERE id = ? AND driver_id = ? AND state IN ('active','ending','recovery_required')`)
    .bind(shiftId, auth.driver_id).first();
  if (!shift) return response({ code: 'shift_conflict', message: 'The shift is not active.', request_id: meta.requestId }, 409, meta.requestId);

  const orderId = parseOrderId(body.order_id);
  const assignment = await env.DB.prepare(`SELECT order_id FROM driver_assignments
    WHERE driver_id = ? AND shift_id = ? AND order_id = ? AND active = 1`)
    .bind(auth.driver_id, shiftId, orderId).first();
  if (!assignment) return response({ code: 'forbidden', message: 'The route task is not assigned to this driver.', request_id: meta.requestId }, 403, meta.requestId);
  const task = await assignedTask(env, shiftId, stopId, orderId);
  if (!task) return response({ code: 'not_found', message: 'Route task not found.', request_id: meta.requestId }, 404, meta.requestId);

  const now = Date.now();
  await env.DB.prepare(`INSERT INTO driver_task_proofs
    (driver_id, shift_id, stop_id, order_id, task_type, signer_name, note,
     photo_url, signature, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shift_id, stop_id) DO UPDATE SET
      signer_name = excluded.signer_name,
      note = excluded.note,
      photo_url = excluded.photo_url,
      signature = excluded.signature,
      updated_at = excluded.updated_at`)
    .bind(
      auth.driver_id,
      shiftId,
      stopId,
      orderId,
      task.task_type,
      body.signer_name || null,
      body.note || null,
      body.photo_data_url || null,
      body.signature_data_url || null,
      now,
      now,
    ).run();

  if (task.task_type === 'dropoff') {
    await upsertDeliveryProof(env.DB, orderId, {
      receiver_name: body.signer_name,
      delivery_note: body.note,
      photo_url: body.photo_data_url,
      signature: body.signature_data_url,
    });
  }
  return response({
    ok: true,
    proof: {
      shift_id: shiftId,
      stop_id: stopId,
      order_id: body.order_id,
      task_type: task.task_type,
      synced_at: new Date(now).toISOString(),
    },
  }, 201, meta.requestId);
}

// Dispositions a driver can report on a failed delivery that leave the package with them.
const RETAINED_FAILURE_DISPOSITIONS = new Set(['return_to_origin', 'hold_for_redelivery']);
// Every retained state where the driver is still carrying the package — the two above plus
// 'redelivery', which Ops promotes once the owner has paid the extra-stop fee. Completion of a
// redelivery marks the order delivered; completion of a return leaves it failed (see below).
const RETAINED_CARRIED = new Set(['return_to_origin', 'hold_for_redelivery', 'redelivery']);

async function applyTaskEvent(env, eventType, task, order, orderId, payload = {}) {
  if (!order || order.status === 'cancelled') {
    return { status: 'accepted_conflict', conflictType: order ? 'order_cancelled' : 'order_missing', transitioned: false };
  }
  if (eventType === 'pickup_completed' && task.task_type !== 'pickup') {
    return { status: 'accepted_conflict', conflictType: 'task_type_mismatch', transitioned: false };
  }
  if (['delivery_completed', 'delivery_failed'].includes(eventType) && task.task_type !== 'dropoff') {
    return { status: 'accepted_conflict', conflictType: 'task_type_mismatch', transitioned: false };
  }

  // A retained package: the order is closed as 'failed' but the driver is still carrying it,
  // and dispatch has given them a return or redelivery leg. Those events cannot go through the
  // normal ladder below, which only reaches 'delivered' from 'to_dropoff' — a retained order
  // sits at 'failed', so every event on the leg would come back as accepted_conflict, and an
  // accepted_conflict makes the driver app block all actions until a full route reload. The
  // leg would be undeliverable and would jam the app.
  if (order.status === 'failed' && RETAINED_CARRIED.has(order.retained_by_driver)) {
    const isRedelivery = order.retained_by_driver === 'redelivery';
    if (eventType === 'navigation_started' || eventType === 'arrived') {
      // Progress on the leg needs no canonical status change.
      return { status: 'accepted', conflictType: null, transitioned: false };
    }
    if (eventType === 'delivery_completed') {
      if (isRedelivery) {
        // A paid redelivery that reached the recipient IS a delivery. Promote the order to
        // 'delivered' and end custody, so the customer timeline and Ops reflect success and
        // the normal delivery notification fires.
        await setOrderStatus(env.DB, orderId, 'delivered', {
          delivered_at: Date.now(), retained_by_driver: null, retained_at: null,
        });
        return { status: 'accepted', conflictType: null, transitioned: true };
      }
      // A return handed back to us. Status stays 'failed' on purpose: the recipient never
      // received it, and calling this 'delivered' would misreport the order. Clearing the
      // column ends custody and retires the leg on the next route sync.
      await env.DB.prepare('UPDATE orders SET retained_by_driver = NULL, retained_at = NULL WHERE id = ?')
        .bind(orderId).run();
      return { status: 'accepted', conflictType: null, transitioned: true };
    }
    if (eventType === 'delivery_failed') {
      // The leg could not be completed. Keep custody exactly as it is and let Ops decide;
      // silently clearing it would lose track of a package still in a vehicle.
      return { status: 'accepted', conflictType: null, transitioned: false };
    }
  }

  const targetStatus = eventType === 'navigation_started'
    ? task.task_type === 'pickup' ? 'to_pickup' : 'to_dropoff'
    : eventType === 'pickup_completed' ? 'picked_up'
    : eventType === 'delivery_completed' ? 'delivered'
    : eventType === 'delivery_failed' ? 'failed'
    : null;
  if (targetStatus == null) return { status: 'accepted', conflictType: null, transitioned: false };

  const allowedFrom = targetStatus === 'to_pickup' ? ['paid']
    : targetStatus === 'to_dropoff' ? ['picked_up']
    : targetStatus === 'picked_up' ? ['to_pickup']
    : targetStatus === 'delivered' || targetStatus === 'failed' ? ['to_dropoff']
    : [];
  if (order.status === targetStatus) return { status: 'accepted', conflictType: null, transitioned: false };
  if (!allowedFrom.includes(order.status)) {
    return { status: 'accepted_conflict', conflictType: 'invalid_canonical_state', transitioned: false };
  }

  const fields = targetStatus === 'picked_up' ? { picked_up_at: Date.now() }
    : targetStatus === 'delivered' ? { delivered_at: Date.now() }
    : {};
  if (targetStatus === 'failed') {
    // Record whether the driver still has the package. Dispatch keeps a retained order
    // eligible and onboard so a return or redelivery leg can be routed; an alternate
    // handoff clears it so the order settles as a normal failure. retained_at anchors the
    // 24h auto-return.
    const retained = RETAINED_FAILURE_DISPOSITIONS.has(payload.disposition);
    fields.retained_by_driver = retained ? payload.disposition : null;
    fields.retained_at = retained ? Date.now() : null;
  }
  await setOrderStatus(env.DB, orderId, targetStatus, fields);
  return { status: 'accepted', conflictType: null, transitioned: true };
}

function executionEventInsertStatement(env, auth, meta, event, orderId, status, conflictType, now) {
  return env.DB.prepare(`INSERT OR IGNORE INTO driver_execution_events
    (event_id, driver_id, shift_id, order_id, stop_id, event_type, occurred_at, route_revision_seen, payload_json, status, conflict_type, server_received_at, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.event_id, auth.driver_id, event.shift_id, orderId, event.stop_id || null,
      event.event_type, event.occurred_at, event.route_revision_seen,
      JSON.stringify(event.payload || {}), status, conflictType, now, meta.requestId);
}

async function processEvent(env, auth, meta, event, executionContext) {
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
  if (event.event_type === 'delivery_failed'
    && event.payload.disposition != null
    && !DELIVERY_FAILURE_DISPOSITIONS.has(event.payload.disposition)) {
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
  let transitioned = false;
  let deliveryTransitionOrder = null;
  if (TASK_EVENT_TYPES.has(event.event_type)) {
    if (orderId == null || event.stop_id == null) {
      return { event_id: event.event_id, status: 'rejected_invalid', server_received_at: new Date().toISOString() };
    }
    const task = await assignedTask(env, event.shift_id, event.stop_id, orderId);
    if (!task) return { event_id: event.event_id, status: 'rejected_auth', server_received_at: new Date().toISOString() };
    const order = await getOrderById(env.DB, orderId);
    if (event.event_type === 'delivery_completed'
      && task.task_type === 'dropoff'
      && order?.status === 'to_dropoff') {
      // This transition is committed below with its event and logical notification jobs.
      deliveryTransitionOrder = order;
    } else {
      const applied = await applyTaskEvent(
        env, event.event_type, task, order, orderId, event.payload,
      );
      status = applied.status;
      conflictType = applied.conflictType;
      transitioned = applied.transitioned;
    }
  }
  const now = Date.now();
  const correlationId = meta.requestId;
  let inserted;
  if (deliveryTransitionOrder) {
    const eventInsert = executionEventInsertStatement(
      env, auth, meta, event, orderId, status, conflictType, now,
    );
    const transition = deliveryCompletionTransitionStatement(
      env.DB, orderId, event.event_id, auth.driver_id, correlationId, now,
    );
    const updateOrder = env.DB.prepare(`UPDATE orders
      SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'to_dropoff'
        AND EXISTS (SELECT 1 FROM delivery_completion_transitions
          WHERE order_id = ? AND event_id = ?)`).bind(now, orderId, orderId, event.event_id);
    const addHistory = env.DB.prepare(`INSERT INTO status_history (order_id, status, at, note)
      SELECT ?, 'delivered', ?, NULL
      WHERE EXISTS (SELECT 1 FROM delivery_completion_transitions
        WHERE order_id = ? AND event_id = ?)
        AND EXISTS (SELECT 1 FROM driver_execution_events
          WHERE event_id = ? AND driver_id = ? AND correlation_id = ?)`)
      .bind(
        orderId, now, orderId, event.event_id,
        event.event_id, auth.driver_id, correlationId,
      );
    const outbox = deliveryNotificationOutboxStatements(
      env.DB, deliveryTransitionOrder, event.event_id, now, { sendWhatsApp: true },
    );
    const results = await env.DB.batch([eventInsert, transition, updateOrder, addHistory, ...outbox]);
    inserted = results[0];
    transitioned = !!results[1]?.meta?.changes;
  } else {
    inserted = await executionEventInsertStatement(
      env, auth, meta, event, orderId, status, conflictType, now,
    ).run();
  }
  if (!inserted?.meta?.changes) {
    const replay = await env.DB.prepare(`SELECT event_id, status, conflict_type, server_received_at, correlation_id
      FROM driver_execution_events WHERE event_id = ? AND driver_id = ?`).bind(event.event_id, auth.driver_id).first();
    if (replay) return { event_id: replay.event_id, status: 'duplicate', server_received_at: new Date(replay.server_received_at).toISOString(), conflict_type: replay.conflict_type, correlation_id: replay.correlation_id };
    return { event_id: event.event_id, status: 'retry_later', server_received_at: new Date(now).toISOString(), correlation_id: correlationId };
  }
  if (env.AUTO_DRIVER_DISPATCH === 'on'
    && status === 'accepted'
    && transitioned
    && ['pickup_completed', 'delivery_completed', 'delivery_failed'].includes(event.event_type)) {
    try {
      await syncDriverRoute(env, {
        driverId: auth.driver_id,
        shiftId: event.shift_id,
        now,
      });
    } catch (error) {
      // The canonical task transition is already durable. A later route poll
      // retries dispatch, so an optimizer outage must not reject completion.
      console.error('driver_route_sync_after_transition_failed', {
        eventId: event.event_id,
        shiftId: event.shift_id,
        message: error?.message || String(error),
      });
    }
  }
  if (event.event_type === 'delivery_completed' && status === 'accepted' && transitioned) {
    const deliveredOrder = await getOrderById(env.DB, orderId);
    if (deliveredOrder && executionContext?.waitUntil) {
      const deferred = runDeliveryCompletionSideEffects(env, deliveredOrder, {
        sendWhatsApp: true,
        notificationsAlreadyEnqueued: true,
        eventId: event.event_id,
      }).catch((error) => {
        // The canonical transition and logical jobs are already durable. Deferred
        // draining is best-effort; the five-minute scheduled worker owns retries.
        console.error('delivery_notification_outbox_immediate_drain_failed', {
          eventId: event.event_id,
          message: error?.message || String(error),
        });
      });
      executionContext.waitUntil(deferred);
    }
  }
  return { event_id: event.event_id, status, server_received_at: new Date(now).toISOString(), conflict_type: conflictType, correlation_id: correlationId };
}

async function eventBatch(req, env, auth, meta, executionContext) {
  let body;
  try { body = await readJson(req); } catch (error) { return response({ code: error.message, message: 'Invalid request.', request_id: meta.requestId }, error.status || 400, meta.requestId); }
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) return response({ code: 'invalid_events', message: 'Expected 1-50 events.', request_id: meta.requestId }, 400, meta.requestId);
  const results = [];
  for (const event of body.events) {
    results.push(await processEvent(env, auth, meta, event, executionContext));
  }
  return response({ results }, 200, meta.requestId);
}

function validLocationSample(sample, shiftStartedAt, now) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return false;
  const allowedKeys = new Set([
    'sample_id',
    'captured_at',
    'latitude',
    'longitude',
    'accuracy_meters',
    'speed_meters_per_second',
  ]);
  if (Object.keys(sample).some((key) => !allowedKeys.has(key))) return false;
  const capturedAt = Date.parse(sample.captured_at);
  return UUID.test(sample.sample_id || '')
    && Number.isFinite(capturedAt)
    && capturedAt >= shiftStartedAt
    && capturedAt <= now + LOCATION_FUTURE_TOLERANCE_MS
    && Number.isFinite(sample.latitude)
    && sample.latitude >= -90 && sample.latitude <= 90
    && Number.isFinite(sample.longitude)
    && sample.longitude >= -180 && sample.longitude <= 180
    && Number.isFinite(sample.accuracy_meters)
    && sample.accuracy_meters >= 0 && sample.accuracy_meters <= 1000
    && (sample.speed_meters_per_second == null
      || (Number.isFinite(sample.speed_meters_per_second)
        && sample.speed_meters_per_second >= 0));
}

async function locationBatch(req, env, auth, meta) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return response(
      { code: error.message, message: 'Invalid request.', request_id: meta.requestId },
      error.status || 400,
      meta.requestId,
    );
  }
  if (!body || !ID.test(body.shift_id || '')
    || !Array.isArray(body.samples) || body.samples.length < 1
    || body.samples.length > MAX_LOCATION_BATCH_SIZE
    || Object.keys(body).some((key) => !['shift_id', 'samples'].includes(key))) {
    return response({
      code: 'invalid_location_samples',
      message: 'Expected 1-100 valid location samples.',
      request_id: meta.requestId,
    }, 400, meta.requestId);
  }
  const shift = await env.DB.prepare(`SELECT id, started_at FROM driver_shifts
    WHERE id = ? AND driver_id = ? AND state IN ('active','ending','recovery_required')`)
    .bind(body.shift_id, auth.driver_id).first();
  if (!shift) {
    return response({
      code: 'shift_conflict',
      message: 'The shift is not active.',
      request_id: meta.requestId,
    }, 409, meta.requestId);
  }
  const now = Date.now();
  if (body.samples.some((sample) => !validLocationSample(sample, shift.started_at, now))) {
    return response({
      code: 'invalid_location_samples',
      message: 'Expected 1-100 valid location samples.',
      request_id: meta.requestId,
    }, 400, meta.requestId);
  }
  let acceptedCount = 0;
  for (const sample of body.samples) {
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO driver_location_samples
      (sample_id, driver_id, shift_id, captured_at, latitude, longitude,
       accuracy_meters, speed_meters_per_second, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        sample.sample_id,
        auth.driver_id,
        body.shift_id,
        new Date(sample.captured_at).toISOString(),
        sample.latitude,
        sample.longitude,
        sample.accuracy_meters,
        sample.speed_meters_per_second ?? null,
        now,
      ).run();
    acceptedCount += Number(inserted?.meta?.changes || 0);
  }
  await env.DB.prepare('DELETE FROM driver_location_samples WHERE recorded_at < ?')
    .bind(now - LOCATION_RETENTION_MS).run();
  return response({ accepted_count: acceptedCount }, 202, meta.requestId);
}

export async function handleDriverApi(
  req,
  env,
  path = new URL(req.url).pathname,
  executionContext,
) {
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
  const proofMatch = /^\/api\/driver\/v1\/shifts\/([^/]+)\/stops\/([^/]+)\/proof$/.exec(path);
  if (proofMatch && req.method === 'POST') return taskProof(
    req,
    env,
    auth,
    meta,
    decodeURIComponent(proofMatch[1]),
    decodeURIComponent(proofMatch[2]),
  );
  if (path === '/api/driver/v1/execution-events:batch' && req.method === 'POST') {
    return eventBatch(req, env, auth, meta, executionContext);
  }
  if (path === '/api/driver/v1/location:batch' && req.method === 'POST') return locationBatch(req, env, auth, meta);
  return response({ code: 'not_found', message: 'Driver API endpoint not found.', request_id: meta.requestId }, 404, meta.requestId);
}

export const driverApiTest = {
  metadata,
  sha256Hex,
  hmacHex,
  parseOrderId,
  validLocationSample,
  processEvent,
};
