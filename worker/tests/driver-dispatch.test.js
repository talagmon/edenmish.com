import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDispatchTasks,
  orderTasksByDistance,
  syncDriverRoute,
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
  constructor(orders, rejectedOrderIds = []) {
    this.orders = orders;
    this.rejectedOrderIds = new Set(rejectedOrderIds);
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
        if (normalized.startsWith('SELECT * FROM driver_routes')) {
          return db.routes
            .filter((route) => route.shift_id === this.args[0])
            .sort((left, right) => right.revision - left.revision)[0] || null;
        }
        if (normalized.startsWith('INSERT INTO driver_routes')) {
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
          });
          return { id };
        }
        return null;
      },
      async run() {
        if (normalized.startsWith('UPDATE driver_assignments SET active = 0')) {
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
          db.stops.push({
            route_id: this.args[0],
            stop_id: this.args[1],
            order_id: this.args[2],
            position: this.args[3],
            task_type: this.args[4],
            required_predecessor_stop_id: this.args[5],
            state: this.args[6],
          });
        }
        return { meta: { changes: 1 } };
      },
    };
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
