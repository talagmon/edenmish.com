import { createGoogleRouteOptimizer } from './route-optimization.js';

const DRIVER_ID = 'drv_eden';
const DRIVER_NAME = 'Eden';
const ELIGIBLE_STATUSES = new Set(['paid', 'to_pickup', 'picked_up', 'to_dropoff']);
const NAVIGATING_STATUSES = new Set(['to_pickup', 'to_dropoff']);
const ROUTE_HORIZON_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SERVICE_SECONDS = 300;
const AVERAGE_SPEED_METERS_PER_SECOND = 25_000 / 3_600;
const DRIVER_LOCATION_MAX_AGE_MS = 5 * 60 * 1000;
const DRIVER_LOCATION_MAX_ACCURACY_METERS = 100;

function validCoordinate(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function location(latitude, longitude) {
  return validCoordinate(latitude, -90, 90) && validCoordinate(longitude, -180, 180)
    ? { latitude, longitude }
    : null;
}

function haversineMeters(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(left.latitude);
  const lat2 = radians(right.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function taskState(order, taskType) {
  if (taskType === 'pickup' && order.status === 'to_pickup') return 'navigating';
  if (taskType === 'dropoff' && order.status === 'to_dropoff') return 'navigating';
  return 'pending';
}

function routeTasksForOrder(order) {
  if (!ELIGIBLE_STATUSES.has(order.status)) return { tasks: [], blocked: false };
  const pickupLocation = location(order.pickup_lat, order.pickup_lng);
  const dropoffLocation = location(order.dropoff_lat, order.dropoff_lng);
  const needsPickup = ['paid', 'to_pickup'].includes(order.status);
  if (!dropoffLocation || (needsPickup && !pickupLocation)) {
    return { tasks: [], blocked: true };
  }
  const pickupStopId = `stop_p${order.id}`;
  const tasks = [];
  if (needsPickup) {
    tasks.push({
      stopId: pickupStopId,
      orderId: Number(order.id),
      taskType: 'pickup',
      requiredPredecessorStopId: null,
      state: taskState(order, 'pickup'),
      location: pickupLocation,
      urgency: order.urgent ? 'urgent' : 'normal',
      serviceDurationSeconds: DEFAULT_SERVICE_SECONDS,
      addressFingerprint: [order.pickup, order.pickup_detail, order.pickup_city]
        .map((value) => value ?? null),
      promisedWindowFingerprint: [order.when_date, order.when_hour, order.service]
        .map((value) => value ?? null),
    });
  }
  tasks.push({
    stopId: `stop_d${order.id}`,
    orderId: Number(order.id),
    taskType: 'dropoff',
    requiredPredecessorStopId: needsPickup ? pickupStopId : null,
    state: taskState(order, 'dropoff'),
    location: dropoffLocation,
    urgency: order.urgent ? 'urgent' : 'normal',
    serviceDurationSeconds: DEFAULT_SERVICE_SECONDS,
    addressFingerprint: [order.dropoff, order.dropoff_detail, order.dropoff_city]
      .map((value) => value ?? null),
    promisedWindowFingerprint: [order.when_date, order.when_hour, order.service]
      .map((value) => value ?? null),
  });
  return { tasks, blocked: false };
}

export function buildDispatchTasks(orders) {
  const tasks = [];
  const blockedOrderIds = [];
  for (const order of orders || []) {
    const result = routeTasksForOrder(order);
    tasks.push(...result.tasks);
    if (result.blocked) blockedOrderIds.push(Number(order.id));
  }
  return { tasks, blockedOrderIds };
}

export function orderTasksByDistance(
  tasks,
  preferredCurrentStopId = null,
  vehicleLocation = null,
) {
  if (!tasks.length) return [];
  const remaining = new Map(tasks.map((task) => [task.stopId, task]));
  const completed = new Set();
  const ordered = [];
  let current = remaining.get(preferredCurrentStopId)
    || tasks.find((task) => task.state === 'navigating')
    || (vehicleLocation ? null : tasks[0]);
  let currentLocation = current?.location || vehicleLocation;
  while (remaining.size > 0) {
    let next = remaining.get(current?.stopId);
    if (!next || (next.requiredPredecessorStopId && !completed.has(next.requiredPredecessorStopId))) {
      const available = [...remaining.values()].filter((task) => (
        !task.requiredPredecessorStopId || completed.has(task.requiredPredecessorStopId)
      ));
      if (!available.length) throw new Error('driver_route_precedence_invalid');
      available.sort((left, right) => {
        const distanceDifference = haversineMeters(currentLocation, left.location)
          - haversineMeters(currentLocation, right.location);
        if (Math.abs(distanceDifference) > 1) return distanceDifference;
        if (left.urgency !== right.urgency) return left.urgency === 'urgent' ? -1 : 1;
        return left.stopId.localeCompare(right.stopId);
      });
      next = available[0];
    }
    ordered.push(next);
    completed.add(next.stopId);
    remaining.delete(next.stopId);
    current = next;
    currentLocation = next.location;
  }
  return ordered;
}

function localEtaByStopId(tasks, now, vehicleLocation = null) {
  const etaByStopId = {};
  let cursor = now;
  let previous = vehicleLocation || tasks[0]?.location || null;
  for (const task of tasks) {
    const distance = Number.isFinite(haversineMeters(previous, task.location))
      ? haversineMeters(previous, task.location) : 0;
    cursor += Math.round((distance / AVERAGE_SPEED_METERS_PER_SECOND) * 1_000);
    etaByStopId[task.stopId] = new Date(cursor).toISOString();
    cursor += task.serviceDurationSeconds * 1_000;
    previous = task.location;
  }
  return etaByStopId;
}

async function optimizedTaskOrder(env, tasks, preferredCurrentStopId, now, vehicleLocation) {
  const fallback = orderTasksByDistance(tasks, preferredCurrentStopId, vehicleLocation);
  let optimizer;
  try {
    optimizer = createGoogleRouteOptimizer(env);
  } catch {
    return { tasks: fallback, etaByStopId: localEtaByStopId(fallback, now, vehicleLocation) };
  }
  if (!optimizer) {
    return { tasks: fallback, etaByStopId: localEtaByStopId(fallback, now, vehicleLocation) };
  }
  const locked = tasks.find((task) => task.stopId === preferredCurrentStopId && task.state === 'navigating')
    || tasks.find((task) => task.state === 'navigating');
  const onboardOrderIds = [...new Set(tasks
    .filter((task) => task.taskType === 'dropoff' && task.requiredPredecessorStopId == null)
    .map((task) => `ord_${task.orderId}`))];
  try {
    const result = await optimizer.optimize({
      routeStartTime: new Date(now).toISOString(),
      routeEndTime: new Date(now + ROUTE_HORIZON_MS).toISOString(),
      vehicleLocation: locked?.location || vehicleLocation || fallback[0].location,
      currentStopLocked: !!locked,
      currentStopId: locked?.stopId || null,
      onboardOrderIds,
      tasks: tasks.map((task) => ({
        stopId: task.stopId,
        orderId: `ord_${task.orderId}`,
        taskType: task.taskType,
        requiredPredecessorStopId: task.requiredPredecessorStopId,
        state: task.state,
        location: task.location,
        serviceDurationSeconds: task.serviceDurationSeconds,
      })),
    });
    const byId = new Map(tasks.map((task) => [task.stopId, task]));
    const ordered = result.stopIds.map((stopId) => byId.get(stopId)).filter(Boolean);
    if (ordered.length !== tasks.length) throw new Error('driver_route_optimizer_incomplete');
    return {
      tasks: ordered,
      etaByStopId: {
        ...localEtaByStopId(ordered, now, locked?.location || vehicleLocation),
        ...result.etaByStopId,
      },
    };
  } catch {
    return {
      tasks: fallback,
      etaByStopId: localEtaByStopId(fallback, now, locked?.location || vehicleLocation),
    };
  }
}

async function eligibleOrders(DB, shiftId = null) {
  const result = await DB.prepare(`SELECT id, status, urgent,
      pickup, pickup_detail, pickup_city, pickup_lat, pickup_lng,
      dropoff, dropoff_detail, dropoff_city, dropoff_lat, dropoff_lng,
      when_date, when_hour, service
    FROM orders
    WHERE status IN ('paid','to_pickup','picked_up','to_dropoff')
      AND (? IS NULL OR NOT EXISTS (
        SELECT 1 FROM driver_execution_events rejected
        WHERE rejected.shift_id = ? AND rejected.order_id = orders.id
          AND rejected.event_type = 'inserted_order_rejected'
          AND rejected.status = 'accepted'
      ))
    ORDER BY urgent DESC, COALESCE(when_date, '9999-12-31'), COALESCE(when_hour, 23), id`)
    .bind(shiftId, shiftId).all();
  return result.results || [];
}

export async function findActiveDriverShift(DB, driverId = DRIVER_ID) {
  return DB.prepare(`SELECT id, driver_id, state, started_at, ended_at, location_expected
    FROM driver_shifts
    WHERE driver_id = ? AND state IN ('active','ending','recovery_required')
    ORDER BY started_at DESC LIMIT 1`).bind(driverId).first();
}

async function syncAssignments(DB, driverId, shiftId, orderIds, now) {
  const existing = await DB.prepare(`SELECT order_id FROM driver_assignments
    WHERE driver_id = ? AND shift_id = ? AND active = 1 ORDER BY order_id`)
    .bind(driverId, shiftId).all();
  const previous = (existing.results || []).map((row) => Number(row.order_id));
  const desired = [...new Set(orderIds)].sort((a, b) => a - b);
  if (previous.length === desired.length && previous.every((value, index) => value === desired[index])) return;
  await DB.prepare('UPDATE driver_assignments SET active = 0 WHERE driver_id = ? AND shift_id = ?')
    .bind(driverId, shiftId).run();
  for (const orderId of desired) {
    await DB.prepare(`INSERT INTO driver_assignments (driver_id, shift_id, order_id, active, assigned_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(driver_id, shift_id, order_id)
      DO UPDATE SET active = 1, assigned_at = excluded.assigned_at`)
      .bind(driverId, shiftId, orderId, now).run();
  }
}

async function latestRoute(DB, shiftId) {
  return DB.prepare(`SELECT * FROM driver_routes WHERE shift_id = ? ORDER BY revision DESC LIMIT 1`)
    .bind(shiftId).first();
}

async function latestRouteStops(DB, routeId) {
  if (!routeId) return [];
  const result = await DB.prepare(`SELECT stop_id, order_id, position, state
    FROM driver_route_stops WHERE route_id = ? ORDER BY position`).bind(routeId).all();
  return result.results || [];
}

async function latestReliableDriverLocation(DB, driverId, shiftId, now) {
  const sample = await DB.prepare(`SELECT latitude, longitude
    FROM driver_location_samples
    WHERE driver_id = ? AND shift_id = ? AND captured_at >= ?
      AND accuracy_meters <= ?
    ORDER BY captured_at DESC LIMIT 1`)
    .bind(
      driverId,
      shiftId,
      new Date(now - DRIVER_LOCATION_MAX_AGE_MS).toISOString(),
      DRIVER_LOCATION_MAX_ACCURACY_METERS,
    ).first();
  return location(sample?.latitude, sample?.longitude);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function planFingerprint(tasks) {
  return sha256Hex(JSON.stringify(tasks.map((task) => ({
    stopId: task.stopId,
    orderId: task.orderId,
    taskType: task.taskType,
    requiredPredecessorStopId: task.requiredPredecessorStopId,
    state: task.state,
    latitude: task.location.latitude,
    longitude: task.location.longitude,
    urgency: task.urgency,
    serviceDurationSeconds: task.serviceDurationSeconds,
    addressFingerprint: task.addressFingerprint,
    promisedWindowFingerprint: task.promisedWindowFingerprint,
  })).sort((left, right) => left.stopId.localeCompare(right.stopId))));
}

async function persistRouteRevision(DB, {
  shiftId,
  revision,
  now,
  latest,
  current,
  tasks,
  etaByStopId,
  onboardOrderIds,
  previousIds,
  fingerprint,
}) {
  const statements = [
    DB.prepare(`INSERT INTO driver_routes
        (shift_id, revision, generated_at, reason, current_stop_id, current_stop_locked,
         delay_minutes, current_position, total_stops, onboard_order_ids_json, plan_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`)
      .bind(
        shiftId,
        revision,
        now,
        latest ? 'queue_changed' : 'shift_started',
        current.stopId,
        current.state === 'navigating' ? 1 : 0,
        tasks.length,
        JSON.stringify(onboardOrderIds),
        fingerprint,
      ),
    ...tasks.map((task, index) => DB.prepare(`INSERT INTO driver_route_stops
        (route_id, stop_id, order_id, position, task_type, required_predecessor_stop_id,
         state, eta, promised_from, promised_to, urgency, inserted, service_duration_seconds)
      VALUES ((SELECT id FROM driver_routes WHERE shift_id = ? AND revision = ?),
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        shiftId,
        revision,
        task.stopId,
        task.orderId,
        index + 1,
        task.taskType,
        task.requiredPredecessorStopId,
        task.state,
        etaByStopId[task.stopId],
        new Date(now).toISOString(),
        new Date(now + ROUTE_HORIZON_MS).toISOString(),
        task.urgency,
        latest && !previousIds.has(task.stopId) ? 1 : 0,
        task.serviceDurationSeconds,
      )),
  ];
  await DB.batch(statements);
  return latestRoute(DB, shiftId);
}

export async function syncDriverRoute(env, {
  driverId = DRIVER_ID,
  shiftId,
  now = Date.now(),
  retryCount = 0,
} = {}) {
  const orders = await eligibleOrders(env.DB, shiftId);
  const { tasks, blockedOrderIds } = buildDispatchTasks(orders);
  const latest = await latestRoute(env.DB, shiftId);
  const previousStops = await latestRouteStops(env.DB, latest?.id);
  const preferredCurrentStopId = previousStops.some((stop) => stop.stop_id === latest?.current_stop_id)
    ? latest.current_stop_id : null;
  const fingerprint = tasks.length ? await planFingerprint(tasks) : null;
  const orderIds = tasks.map((task) => task.orderId);
  await syncAssignments(env.DB, driverId, shiftId, orderIds, now);
  if (!tasks.length) {
    return {
      empty: true,
      route: null,
      readyOrderCount: orders.length,
      blockedOrderCount: blockedOrderIds.length,
      taskCount: 0,
    };
  }
  if (latest && latest.plan_fingerprint === fingerprint) {
    return {
      empty: false,
      route: latest,
      readyOrderCount: orders.length,
      blockedOrderCount: blockedOrderIds.length,
      taskCount: tasks.length,
    };
  }
  const driverLocation = await latestReliableDriverLocation(env.DB, driverId, shiftId, now);
  const optimized = await optimizedTaskOrder(
    env, tasks, preferredCurrentStopId, now, driverLocation,
  );
  const revision = Number(latest?.revision || 0) + 1;
  const previousIds = new Set(previousStops.map((stop) => stop.stop_id));
  const onboardOrderIds = [...new Set(orders
    .filter((order) => ['picked_up', 'to_dropoff'].includes(order.status))
    .map((order) => Number(order.id)))];
  const current = optimized.tasks[0];
  let inserted;
  try {
    inserted = await persistRouteRevision(env.DB, {
      shiftId,
      revision,
      now,
      latest,
      current,
      tasks: optimized.tasks,
      etaByStopId: optimized.etaByStopId,
      onboardOrderIds,
      previousIds,
      fingerprint,
    });
  } catch (error) {
    const concurrent = await latestRoute(env.DB, shiftId);
    if (Number(concurrent?.revision || 0) < revision || retryCount >= 2) throw error;
    if (concurrent.plan_fingerprint === fingerprint) inserted = concurrent;
    else {
      return syncDriverRoute(env, {
        driverId,
        shiftId,
        now,
        retryCount: retryCount + 1,
      });
    }
  }
  return {
    empty: false,
    route: { id: inserted.id, revision: inserted.revision },
    readyOrderCount: orders.length,
    blockedOrderCount: blockedOrderIds.length,
    taskCount: optimized.tasks.length,
  };
}

export async function startDriverShift(env, { now = Date.now() } = {}) {
  await env.DB.prepare(`INSERT INTO drivers (id, display_name, locale, active, created_at)
    VALUES (?, ?, 'he-IL', 1, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, active = 1`)
    .bind(DRIVER_ID, DRIVER_NAME, now).run();
  let shift = await findActiveDriverShift(env.DB);
  let unchanged = true;
  if (!shift) {
    unchanged = false;
    const id = `sh_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.prepare(`INSERT INTO driver_shifts
      (id, driver_id, state, started_at, ended_at, location_expected)
      VALUES (?, ?, 'active', ?, NULL, 1)`).bind(id, DRIVER_ID, now).run();
    shift = await findActiveDriverShift(env.DB);
  }
  const dispatch = await syncDriverRoute(env, { shiftId: shift.id, now });
  return { shift, dispatch, unchanged };
}

export async function endDriverShift(env, { now = Date.now() } = {}) {
  const shift = await findActiveDriverShift(env.DB);
  if (!shift) return { shift: null, unchanged: true };
  await env.DB.prepare(`UPDATE driver_shifts
    SET state = 'ended', ended_at = ?, location_expected = 0 WHERE id = ?`)
    .bind(now, shift.id).run();
  await env.DB.prepare('UPDATE driver_assignments SET active = 0 WHERE driver_id = ? AND shift_id = ?')
    .bind(DRIVER_ID, shift.id).run();
  return { shift: { ...shift, state: 'ended', ended_at: now, location_expected: 0 }, unchanged: false };
}

export async function driverDispatchStatus(env) {
  const shift = await findActiveDriverShift(env.DB);
  const orders = await eligibleOrders(env.DB, shift?.id || null);
  const { tasks, blockedOrderIds } = buildDispatchTasks(orders);
  if (!shift) {
    return {
      active: false,
      shift: null,
      routeRevision: null,
      readyOrderCount: orders.length,
      blockedOrderCount: blockedOrderIds.length,
      taskCount: tasks.length,
    };
  }
  const route = await latestRoute(env.DB, shift.id);
  return {
    active: true,
    shift,
    routeRevision: route?.revision || null,
    readyOrderCount: orders.length,
    blockedOrderCount: blockedOrderIds.length,
    taskCount: tasks.length,
  };
}

export const driverDispatchTest = {
  haversineMeters,
  routeTasksForOrder,
  planFingerprint,
};
