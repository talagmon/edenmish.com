import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDispatchTasks,
  orderTasksByDistance,
  syncDriverRoute,
  syncDriverRouteAndNotify,
} from '../src/driver-dispatch.js';

function order(id, status, pickupLng, dropoffLng, extra = {}) {
  return {
    id,
    status,
    urgent: 0,
    pickup_lat: 32,
    pickup_lng: pickupLng,
    dropoff_lat: 32,
    dropoff_lng: dropoffLng,
    ...extra,
  };
}

class DispatchDb {
  constructor(orders, rejectedOrderIds = [], driverLocation = null) {
    this.orders = orders;
    this.rejectedOrderIds = new Set(rejectedOrderIds);
    this.driverLocation = driverLocation;
    this.assignments = [];
    this.routes = [];
    this.stops = [];
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const db = this;
    return {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async all() {
        if (normalized.includes("FROM orders") && normalized.includes("status IN")) {
          return { results: db.orders.filter((candidate) => (
            ['paid', 'to_pickup', 'picked_up', 'to_dropoff'].includes(candidate.status)
            && (!this.args[0] || !db.rejectedOrderIds.has(candidate.id))
          )) };
        }
        if (normalized.startsWith('SELECT order_id FROM driver_assignments')) {
          return { results: db.assignments
            .filter((row) => row.driver_id === this.args[0] && row.shift_id === this.args[1] && row.active)
            .sort((left, right) => left.order_id - right.order_id)
            .map((row) => ({ order_id: row.order_id })) };
        }
        if (normalized.startsWith('SELECT stop_id, order_id, position, state')) {
          return { results: db.stops
            .filter((row) => row.route_id === this.args[0])
            .sort((left, right) => left.position - right.position) };
        }
        return { results: [] };
      },
      async first() {
        if (normalized.startsWith('SELECT latitude, longitude')) {
          return db.driverLocation;
        }
        if (normalized.startsWith('SELECT * FROM driver_routes')) {
          return db.routes
            .filter((route) => route.shift_id === this.args[0])
            .sort((left, right) => right.revision - left.revision)[0] || null;
        }
        return null;
      },
      async run() {
        if (normalized.startsWith('INSERT INTO driver_routes')) {
          if (db.routes.some((route) => (
            route.shift_id === this.args[0] && route.revision === this.args[1]
          ))) throw new Error('UNIQUE constraint failed: driver_routes.shift_id, revision');
          const id = db.routes.length + 1;
          db.routes.push({
            id,
            shift_id: this.args[0],
            revision: this.args[1],
            generated_at: this.args[2],
            reason: this.args[3],
            current_stop_id: this.args[4],
            current_stop_locked: this.args[5],
            total_stops: this.args[6],
            onboard_order_ids_json: this.args[7],
            plan_fingerprint: this.args[8],
          });
        } else if (normalized.startsWith('UPDATE driver_assignments SET active = 0')) {
          for (const row of db.assignments) {
            if (row.driver_id === this.args[0] && row.shift_id === this.args[1]) row.active = 0;
          }
        } else if (normalized.startsWith('INSERT INTO driver_assignments')) {
          const [driverId, shiftId, orderId, assignedAt] = this.args;
          const existing = db.assignments.find((row) => (
            row.driver_id === driverId && row.shift_id === shiftId && row.order_id === orderId
          ));
          if (existing) Object.assign(existing, { active: 1, assigned_at: assignedAt });
          else db.assignments.push({ driver_id: driverId, shift_id: shiftId, order_id: orderId, active: 1, assigned_at: assignedAt });
        } else if (normalized.startsWith('INSERT INTO driver_route_stops')) {
          const route = db.routes.find((candidate) => (
            candidate.shift_id === this.args[0] && candidate.revision === this.args[1]
          ));
          db.stops.push({
            route_id: route.id,
            stop_id: this.args[2],
            order_id: this.args[3],
            position: this.args[4],
            task_type: this.args[5],
            required_predecessor_stop_id: this.args[6],
            state: this.args[7],
          });
        }
        return { meta: { changes: 1 } };
      },
    };
  }

  async batch(statements) {
    const routes = structuredClone(this.routes);
    const stops = structuredClone(this.stops);
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.routes = routes;
      this.stops = stops;
      throw error;
    }
  }
}

describe('driver dispatch planning', () => {
  test('builds mixed pickup/drop-off tasks and excludes an already completed pickup', () => {
    const { tasks, blockedOrderIds } = buildDispatchTasks([
      order(1, 'paid', 34.77, 34.78),
      order(2, 'picked_up', 34.79, 34.80),
    ]);

    assert.deepEqual(tasks.map((task) => task.stopId), ['stop_p1', 'stop_d1', 'stop_d2']);
    assert.equal(tasks[1].requiredPredecessorStopId, 'stop_p1');
    assert.equal(tasks[2].requiredPredecessorStopId, null);
    assert.deepEqual(blockedOrderIds, []);
  });

  test('routes a return leg for a retained package and holds a redelivery until it is paid', () => {
    const returning = order(5, 'failed', 34.77, 34.90, {
      retained_by_driver: 'return_to_origin',
      pickup: 'הרצל 42',
      pickup_city: 'תל אביב',
    });
    const holding = order(6, 'failed', 34.81, 34.95, {
      retained_by_driver: 'hold_for_redelivery',
    });
    const settled = order(7, 'failed', 34.83, 34.97, { retained_by_driver: null });

    const { tasks, blockedOrderIds } = buildDispatchTasks([returning, holding, settled]);

    // return_to_origin becomes a lone drop-off back at the pickup coordinates, under a stop id
    // distinct from the stop_d5 that failed so a replayed failure cannot kill the new leg.
    assert.deepEqual(tasks.map((task) => task.stopId), ['stop_r5']);
    assert.equal(tasks[0].taskType, 'dropoff');
    assert.equal(tasks[0].requiredPredecessorStopId, null);
    assert.equal(tasks[0].location.longitude, 34.77);
    assert.deepEqual(tasks[0].addressFingerprint, ['הרצל 42', null, 'תל אביב']);

    // hold_for_redelivery yields no stop: the driver must not see a redelivery before Ops has
    // created the fee and the owner has paid it. A settled failure yields nothing either.
    assert.deepEqual(blockedOrderIds, []);
  });

  test('a released redelivery routes a fresh drop-off to the corrected destination', () => {
    // After Ops releases it, the corrected address is on the live dropoff_* columns and the
    // order carries retained_by_driver = 'redelivery'.
    const redelivery = order(9, 'failed', 34.77, 34.83, {
      retained_by_driver: 'redelivery',
      dropoff: 'ויצמן 14',
      dropoff_city: 'גבעתיים',
    });
    const { tasks, blockedOrderIds } = buildDispatchTasks([redelivery]);

    // A lone drop-off to the new destination, under stop_x9 — distinct from both stop_d9 (the
    // failed attempt) and stop_r9 (a return), so no earlier terminal event can touch it.
    assert.deepEqual(tasks.map((task) => task.stopId), ['stop_x9']);
    assert.equal(tasks[0].taskType, 'dropoff');
    assert.equal(tasks[0].requiredPredecessorStopId, null);
    assert.equal(tasks[0].location.longitude, 34.83);
    assert.deepEqual(tasks[0].addressFingerprint, ['ויצמן 14', null, 'גבעתיים']);
    assert.deepEqual(blockedOrderIds, []);
  });

  test('a retained return without pickup coordinates is blocked rather than mislocated', () => {
    const { tasks, blockedOrderIds } = buildDispatchTasks([
      { id: 8, status: 'failed', urgent: 0, retained_by_driver: 'return_to_origin' },
    ]);

    assert.deepEqual(tasks, []);
    assert.deepEqual(blockedOrderIds, [8]);
  });

  test('orders by distance while preserving pickup-before-drop-off precedence', () => {
    const { tasks } = buildDispatchTasks([
      order(10, 'picked_up', 34.70, 34.710),
      order(11, 'paid', 34.720, 34.730),
      order(12, 'paid', 34.711, 34.740),
    ]);

    const ordered = orderTasksByDistance(tasks);

    assert.deepEqual(ordered.map((task) => task.stopId), [
      'stop_d10', 'stop_p12', 'stop_p11', 'stop_d11', 'stop_d12',
    ]);
    for (const task of ordered.filter((candidate) => candidate.taskType === 'dropoff')) {
      if (!task.requiredPredecessorStopId) continue;
      assert.ok(ordered.findIndex((candidate) => candidate.stopId === task.requiredPredecessorStopId)
        < ordered.findIndex((candidate) => candidate.stopId === task.stopId));
    }
  });

  test('keeps an ongoing navigation task locked at the front', () => {
    const { tasks } = buildDispatchTasks([
      order(1, 'paid', 34.77, 34.78),
      order(2, 'to_pickup', 34.79, 34.80),
    ]);

    const ordered = orderTasksByDistance(tasks, 'stop_p2');

    assert.equal(ordered[0].stopId, 'stop_p2');
  });

  test('starts an unlocked route at the task nearest the driver', () => {
    const { tasks } = buildDispatchTasks([
      order(1, 'paid', 35.10, 35.11),
      order(2, 'paid', 34.80, 34.81),
    ]);

    const ordered = orderTasksByDistance(tasks, null, {
      latitude: 32,
      longitude: 34.79,
    });

    assert.equal(ordered[0].stopId, 'stop_p2');
  });

  test('blocks eligible orders that do not have every required coordinate', () => {
    const result = buildDispatchTasks([
      order(1, 'paid', null, 34.78),
      order(2, 'picked_up', null, 34.80),
    ]);

    assert.deepEqual(result.tasks.map((task) => task.stopId), ['stop_d2']);
    assert.deepEqual(result.blockedOrderIds, [1]);
  });

  test('persists one immutable revision and only adds another when the queue changes', async () => {
    const db = new DispatchDb([order(1, 'paid', 34.77, 34.78)]);
    const env = { DB: db };

    const first = await syncDriverRoute(env, { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:00:00Z') });
    const replay = await syncDriverRoute(env, { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:01:00Z') });
    db.orders.push(order(2, 'paid', 34.79, 34.80));
    const changed = await syncDriverRoute(env, { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:02:00Z') });

    assert.equal(first.route.revision, 1);
    assert.equal(replay.route.revision, 1);
    assert.equal(changed.route.revision, 2);
    assert.equal(db.routes.length, 2);
    assert.deepEqual(db.assignments.filter((row) => row.active).map((row) => row.order_id), [1, 2]);
  });

  test('attempts a best-effort push only when route reconciliation creates a revision', async () => {
    const db = new DispatchDb([order(1, 'paid', 34.77, 34.78)]);
    const env = { DB: db };

    const first = await syncDriverRouteAndNotify(env, {
      driverId: 'drv_eden',
      shiftId: 'sh_1',
      now: Date.parse('2026-07-19T17:00:00Z'),
    });
    const replay = await syncDriverRouteAndNotify(env, {
      driverId: 'drv_eden',
      shiftId: 'sh_1',
      now: Date.parse('2026-07-19T17:01:00Z'),
    });

    assert.equal(first.changed, true);
    assert.deepEqual(first.addedStopIds, ['stop_p1', 'stop_d1']);
    assert.deepEqual(first.notification, {
      configured: false,
      attempted: 0,
      sent: 0,
      failed: 0,
    });
    assert.equal(replay.changed, false);
    assert.equal('notification' in replay, false);
  });

  test('creates a new revision when routing inputs change', async () => {
    const db = new DispatchDb([order(1, 'paid', 34.77, 34.78, {
      pickup: 'Old pickup',
    })]);
    const env = { DB: db };

    const first = await syncDriverRoute(env, {
      shiftId: 'sh_1',
      now: Date.parse('2026-07-19T17:00:00Z'),
    });
    db.orders[0].pickup_lng = 34.90;
    db.orders[0].pickup = 'New pickup';
    const changed = await syncDriverRoute(env, {
      shiftId: 'sh_1',
      now: Date.parse('2026-07-19T17:01:00Z'),
    });

    assert.equal(first.route.revision, 1);
    assert.equal(changed.route.revision, 2);
    assert.equal(db.routes.length, 2);
  });

  test('serializes concurrent route generation into one revision', async () => {
    const db = new DispatchDb([order(1, 'paid', 34.77, 34.78)]);
    const env = { DB: db };

    const [left, right] = await Promise.all([
      syncDriverRoute(env, { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:00:00Z') }),
      syncDriverRoute(env, { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:00:00Z') }),
    ]);

    assert.equal(left.route.revision, 1);
    assert.equal(right.route.revision, 1);
    assert.equal(db.routes.length, 1);
    assert.equal(db.stops.length, 2);
  });

  test('uses a fresh accurate driver sample as the dispatch origin', async () => {
    const db = new DispatchDb([
      order(1, 'paid', 35.10, 35.11),
      order(2, 'paid', 34.80, 34.81),
    ], [], { latitude: 32, longitude: 34.79 });

    await syncDriverRoute(
      { DB: db },
      { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:00:00Z') },
    );

    assert.equal(db.stops[0].stop_id, 'stop_p2');
  });

  test('keeps a rejected inserted order out of the active shift route', async () => {
    const db = new DispatchDb([
      order(1, 'paid', 34.77, 34.78),
      order(2, 'paid', 34.79, 34.80),
    ], [2]);

    const result = await syncDriverRoute(
      { DB: db },
      { shiftId: 'sh_1', now: Date.parse('2026-07-19T17:00:00Z') },
    );

    assert.equal(result.readyOrderCount, 1);
    assert.deepEqual(db.assignments.filter((row) => row.active).map((row) => row.order_id), [1]);
    assert.deepEqual(db.stops.map((row) => row.order_id), [1, 1]);
  });
});
