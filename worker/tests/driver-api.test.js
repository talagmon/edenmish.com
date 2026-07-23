import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleDriverApi } from '../src/driver-api.js';
import worker from '../src/index.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const installationId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';

function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-request-id': requestId,
    'x-device-installation-id': installationId,
    'x-client-version': '1.0.0+1',
    ...extra,
  };
}

function request(path, init = {}) {
  return new Request(`https://ops-staging.edenmish.com${path}`, {
    ...init,
    headers: headers(init.headers),
  });
}

function fakeDb({ first, all, run } = {}) {
  const calls = [];
  const batches = [];
  return {
    calls,
    batches,
    prepare(sql) {
      const call = { sql: sql.replace(/\s+/g, ' ').trim(), args: [] };
      calls.push(call);
      return {
        bind(...args) {
          call.args = args;
          return this;
        },
        first: async () => first ? first(call) : null,
        all: async () => all ? all(call) : { results: [] },
        run: async () => run ? run(call) : { meta: { changes: 1 } },
      };
    },
    async batch(statements) {
      batches.push(statements);
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function authenticatedFirst(call) {
  if (call.sql.includes('FROM driver_sessions s JOIN drivers')) {
    return { driver_id: 'drv_eden', display_name: 'Eden', locale: 'he-IL' };
  }
  return null;
}

describe('driver API v1', () => {
  test('rejects missing device metadata before accessing D1', async () => {
    const req = new Request('https://example.test/api/driver/v1/shifts/current', {
      headers: { 'x-request-id': requestId, 'x-client-version': '1.0.0+1' },
    });

    const res = await handleDriverApi(req, {});

    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid_installation_id');
  });

  test('accepts a client version with the app Git revision suffix', async () => {
    const db = fakeDb();
    const res = await handleDriverApi(request('/api/driver/v1/shifts/current', {
      headers: { 'x-client-version': '1.0.0+287583 (ac2a166d9a12)' },
    }), { DB: db });

    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'unauthorized');
  });

  test('rejects arbitrary client version annotations', async () => {
    const res = await handleDriverApi(request('/api/driver/v1/shifts/current', {
      headers: { 'x-client-version': '1.0.0+287583 (production)' },
    }), {});

    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid_client_version');
  });

  test('rejects an invalid bearer token without revealing session details', async () => {
    const db = fakeDb();
    const res = await handleDriverApi(request('/api/driver/v1/shifts/current', {
      headers: { authorization: 'Bearer invalid-token' },
    }), { DB: db });

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      code: 'unauthorized',
      message: 'Driver session is invalid.',
      request_id: requestId,
    });
  });

  test('exchanges a single-use code and persists only token/code digests', async () => {
    const db = fakeDb({
      first: (call) => call.sql.includes('FROM rate_limits') ? null : null,
    });
    const res = await handleDriverApi(request('/api/driver/v1/session', {
      method: 'POST',
      body: JSON.stringify({ one_time_code: '845921' }),
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    }), {
      DB: db,
      SESSION_SECRET: 'test-session-secret-with-enough-entropy',
      DRIVER_ONE_TIME_CODE: '845921',
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.driver.driver_id, 'drv_eden');
    assert.equal(body.driver.locale, 'he-IL');
    assert.ok(body.access_token.length >= 32);
    assert.ok(body.refresh_token.length >= 32);

    const insert = db.calls.find((call) => call.sql.includes('INSERT OR IGNORE INTO driver_sessions'));
    assert.ok(insert);
    assert.equal(insert.args[2], installationId);
    assert.match(insert.args[3], /^[0-9a-f]{64}$/);
    assert.match(insert.args[4], /^[0-9a-f]{64}$/);
    assert.match(insert.args[5], /^[0-9a-f]{64}$/);
    assert.ok(!insert.args.includes('845921'));
    assert.ok(!insert.args.includes(body.access_token));
    assert.ok(!insert.args.includes(body.refresh_token));
  });

  test('rejects a bootstrap code that has already been consumed', async () => {
    const db = fakeDb({
      first: () => null,
      run: (call) => ({ meta: { changes: call.sql.includes('INSERT OR IGNORE INTO driver_sessions') ? 0 : 1 } }),
    });
    const res = await handleDriverApi(request('/api/driver/v1/session', {
      method: 'POST',
      body: JSON.stringify({ one_time_code: '845921' }),
    }), {
      DB: db,
      SESSION_SECRET: 'test-session-secret-with-enough-entropy',
      DRIVER_ONE_TIME_CODE: '845921',
    });

    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'invalid_credentials');
  });

  test('rotates both tokens using an installation-bound refresh token', async () => {
    const oldRefreshToken = 'old-refresh-token-with-at-least-32-characters';
    const db = fakeDb({
      first: (call) => call.sql.includes('WHERE s.refresh_token_hash')
        ? { id: 'ds_123', driver_id: 'drv_eden', display_name: 'Eden', locale: 'he-IL' }
        : null,
    });
    const res = await handleDriverApi(request('/api/driver/v1/session/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: oldRefreshToken }),
    }), { DB: db });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.notEqual(body.refresh_token, oldRefreshToken);
    assert.ok(body.access_token.length >= 32);
    const update = db.calls.find((call) => call.sql.startsWith('UPDATE driver_sessions'));
    assert.ok(update);
    assert.match(update.args[0], /^[0-9a-f]{64}$/);
    assert.match(update.args[1], /^[0-9a-f]{64}$/);
    assert.equal(update.args[4], 'ds_123');
  });

  test('returns the authenticated driver current shift', async () => {
    const startedAt = Date.parse('2026-07-18T14:00:00Z');
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.includes('FROM driver_shifts WHERE driver_id')) {
          return { id: 'sh_123', state: 'active', started_at: startedAt, ended_at: null, location_expected: 1 };
        }
        return null;
      },
    });

    const res = await handleDriverApi(request('/api/driver/v1/shifts/current', {
      headers: { authorization: 'Bearer valid-token' },
    }), { DB: db });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      shift_id: 'sh_123',
      state: 'active',
      started_at: '2026-07-18T14:00:00.000Z',
      ended_at: null,
      location_expected: true,
    });
  });

  test('returns a revisioned mixed pickup/drop-off task route', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql === 'SELECT id FROM driver_shifts WHERE id = ? AND driver_id = ?') return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_routes')) return {
          id: 7,
          revision: 13,
          generated_at: Date.parse('2026-07-18T15:31:22Z'),
          reason: 'new_order_inserted',
          current_stop_id: 'stop_p1',
          current_stop_locked: 1,
          delay_minutes: 4,
          current_position: 1,
          total_stops: 7,
          onboard_order_ids_json: '[9000]',
        };
        return null;
      },
      all: (call) => {
        if (call.sql.includes('FROM driver_execution_events')) {
          return { results: [{ stop_id: 'stop_p1', event_type: 'arrived' }] };
        }
        return call.sql.includes('FROM driver_route_stops') ? { results: [{
          stop_id: 'stop_p1', order_id: 9001, position: 1, task_type: 'pickup',
          required_predecessor_stop_id: null, state: 'navigating',
          name: 'נועה לוי', phone: '+972541234567', pickup: 'הרצל 42, תל אביב',
          pickup_detail: 'קומה 2', pickup_lat: 32.0632, pickup_lng: 34.7708,
          dropoff: 'אבן גבירול 81, תל אביב', dropoff_detail: null,
          dropoff_lat: 32.0801, dropoff_lng: 34.7813,
          promised_from: '2026-07-18T15:00:00Z', promised_to: '2026-07-18T16:00:00Z',
          eta: '2026-07-18T15:35:00Z', service_duration_seconds: 300,
          urgency: 'normal', inserted: 0,
        }, {
          stop_id: 'stop_d0', order_id: 9000, position: 2, task_type: 'dropoff',
          required_predecessor_stop_id: 'stop_p0', state: 'pending',
          name: 'מיכל רוזן', phone: '+972521234567', pickup: 'הנמל 3, תל אביב',
          pickup_detail: null, pickup_lat: 32.0983, pickup_lng: 34.7749,
          dropoff: 'בן גוריון 97, תל אביב', dropoff_detail: 'כניסה ב',
          dropoff_lat: 32.0861, dropoff_lng: 34.7806,
          promised_from: '2026-07-18T15:20:00Z', promised_to: '2026-07-18T16:05:00Z',
          eta: '2026-07-18T15:47:00Z', service_duration_seconds: 420,
          urgency: 'urgent', inserted: 1,
        }] } : { results: [] };
      },
    });

    const res = await handleDriverApi(request('/api/driver/v1/shifts/sh_123/route', {
      headers: { authorization: 'Bearer valid-token' },
    }), { DB: db });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"route-sh_123-13"');
    assert.equal(body.revision, 13);
    assert.deepEqual(body.onboard_order_ids, ['ord_9000']);
    assert.equal(body.stops[0].task_type, 'pickup');
    assert.equal(body.stops[0].state, 'arrived');
    assert.equal(body.stops[0].contact.display_name, 'נועה לוי');
    assert.equal(body.stops[0].address.display_text, 'הרצל 42, תל אביב · קומה 2');
    assert.equal(body.stops[1].task_type, 'dropoff');
    assert.equal(body.stops[1].required_predecessor_stop_id, 'stop_p0');
    assert.equal(body.stops[1].service_duration_seconds, 420);
    assert.deepEqual(body.change_summary.added_stop_ids, ['stop_d0']);
  });

  test('stores authenticated pickup proof against the assigned route task', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.includes('FROM driver_shifts') && call.sql.includes("state IN")) {
          return { id: 'sh_123' };
        }
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
        if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
          return { stop_id: 'stop_p1', task_type: 'pickup' };
        }
        return null;
      },
    });

    const res = await handleDriverApi(request(
      '/api/driver/v1/shifts/sh_123/stops/stop_p1/proof',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          order_id: 'ord_9001',
          signer_name: 'Eden',
          note: 'Collected from reception',
          photo_data_url: 'data:image/jpeg;base64,AA==',
          signature_data_url: 'data:image/png;base64,AA==',
        }),
      },
    ), { DB: db });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.proof.task_type, 'pickup');
    assert.equal(body.proof.stop_id, 'stop_p1');
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO driver_task_proofs'));
    assert.ok(insert);
    assert.deepEqual(insert.args.slice(0, 9), [
      'drv_eden',
      'sh_123',
      'stop_p1',
      9001,
      'pickup',
      'Eden',
      'Collected from reception',
      'data:image/jpeg;base64,AA==',
      'data:image/png;base64,AA==',
    ]);
  });

  test('rejects proof for an order not assigned to the driver', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.includes('FROM driver_shifts') && call.sql.includes("state IN")) {
          return { id: 'sh_123' };
        }
        return null;
      },
    });

    const res = await handleDriverApi(request(
      '/api/driver/v1/shifts/sh_123/stops/stop_p1/proof',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          order_id: 'ord_9001',
          photo_data_url: 'data:image/jpeg;base64,AA==',
        }),
      },
    ), { DB: db });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'forbidden');
    assert.equal(
      db.calls.some((call) => call.sql.includes('INSERT INTO driver_task_proofs')),
      false,
    );
  });

  test('requires a valid photo or signature for task proof', async () => {
    const db = fakeDb({ first: authenticatedFirst });
    const res = await handleDriverApi(request(
      '/api/driver/v1/shifts/sh_123/stops/stop_p1/proof',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ order_id: 'ord_9001', note: 'No evidence' }),
      },
    ), { DB: db });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid_proof');
  });

  test('advances the canonical order when a pickup task completes', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) return null;
        if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
        if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
          return { stop_id: 'stop_p1', task_type: 'pickup' };
        }
        if (call.sql === 'SELECT * FROM orders WHERE id = ?') return { id: 9001, status: 'to_pickup' };
        return null;
      },
    });
    const event = {
      event_id: eventId,
      event_type: 'pickup_completed',
      occurred_at: '2026-07-18T15:00:00Z',
      recorded_at_monotonic_ms: 42,
      shift_id: 'sh_123',
      order_id: 'ord_9001',
      stop_id: 'stop_p1',
      route_revision_seen: 13,
      payload: {},
    };

    const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ events: [event] }),
    }), { DB: db });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.results[0].status, 'accepted');
    const orderUpdate = db.calls.find((call) => call.sql.startsWith('UPDATE orders SET'));
    assert.ok(orderUpdate);
    assert.equal(orderUpdate.args[0], 'picked_up');
    assert.equal(orderUpdate.args.at(-1), 9001);
    assert.ok(db.calls.some((call) => call.sql.includes('INSERT INTO status_history')));
  });

  test('starts drop-off navigation only after the package is picked up', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) return null;
        if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
        if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
          return { stop_id: 'stop_d1', task_type: 'dropoff' };
        }
        if (call.sql === 'SELECT * FROM orders WHERE id = ?') return { id: 9001, status: 'picked_up' };
        return null;
      },
    });
    const event = {
      event_id: eventId,
      event_type: 'navigation_started',
      occurred_at: '2026-07-18T15:00:00Z',
      recorded_at_monotonic_ms: 42,
      shift_id: 'sh_123',
      order_id: 'ord_9001',
      stop_id: 'stop_d1',
      route_revision_seen: 13,
      payload: {},
    };

    const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ events: [event] }),
    }), { DB: db });
    const body = await res.json();

    assert.equal(body.results[0].status, 'accepted');
    const orderUpdate = db.calls.find((call) => call.sql.startsWith('UPDATE orders SET'));
    assert.equal(orderUpdate.args[0], 'to_dropoff');
  });

  test('atomically creates one logical notification job per channel on delivery', async () => {
    const order = {
      id: 9001,
      token: 'deliverytoken9001',
      status: 'to_dropoff',
      payment_mode: 'immediate',
      email: 'customer@example.com',
      phone: '+972541234567',
      pickup: 'Pickup address',
      dropoff: 'Drop-off address',
      price: 50,
    };
    let eventStored = false;
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) {
          return eventStored
            ? {
              event_id: eventId,
              status: 'accepted',
              conflict_type: null,
              server_received_at: Date.parse('2026-07-18T15:00:01Z'),
              correlation_id: requestId,
            }
            : null;
        }
        if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
        if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
          return { stop_id: 'stop_d1', task_type: 'dropoff' };
        }
        if (call.sql === 'SELECT * FROM orders WHERE id = ?') return order;
        return null;
      },
      run: (call) => {
        if (call.sql.startsWith("UPDATE orders SET status = 'delivered'")) {
          order.status = 'delivered';
        } else if (call.sql.startsWith('UPDATE orders SET')) {
          order.status = call.args[0];
        }
        if (call.sql.includes('INSERT OR IGNORE INTO driver_execution_events')) {
          eventStored = true;
        }
        return { meta: { changes: 1 } };
      },
    });
    const event = {
      event_id: eventId,
      event_type: 'delivery_completed',
      occurred_at: '2026-07-18T15:00:00Z',
      recorded_at_monotonic_ms: 42,
      shift_id: 'sh_123',
      order_id: 'ord_9001',
      stop_id: 'stop_d1',
      route_revision_seen: 13,
      payload: {},
    };
    const send = (executionContext) => worker.fetch(request('/api/driver/v1/execution-events:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ events: [event] }),
    }), { DB: db }, executionContext);

    const deferred = [];
    const firstResponse = await send({ waitUntil: (promise) => deferred.push(promise) });
    assert.equal((await firstResponse.json()).results[0].status, 'accepted');
    assert.equal(deferred.length, 1);
    assert.ok(deferred[0] instanceof Promise);
    await deferred[0];
    assert.equal(order.status, 'delivered');
    assert.equal(db.batches.length, 1);
    assert.equal(db.batches[0].length, 6);
    const notificationJobs = db.calls.filter((call) => (
      call.sql.startsWith('INSERT OR IGNORE INTO delivery_notification_outbox')
    ));
    assert.equal(notificationJobs.length, 2);
    assert.deepEqual(
      notificationJobs.map((call) => call.args[2]),
      [
        'email',
        'whatsapp',
      ],
    );

    const replayResponse = await send();
    assert.equal((await replayResponse.json()).results[0].status, 'duplicate');
    assert.equal(
      db.calls.filter((call) => (
        call.sql.startsWith('INSERT OR IGNORE INTO delivery_notification_outbox')
      )).length,
      2,
    );
  });

  test('treats a replayed execution event as an idempotent duplicate', async () => {
    const receivedAt = Date.parse('2026-07-18T15:00:01Z');
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) {
          return { event_id: eventId, status: 'accepted', conflict_type: null, server_received_at: receivedAt, correlation_id: requestId };
        }
        return null;
      },
    });

    const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ events: [{ event_id: eventId }] }),
    }), { DB: db });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.results[0].status, 'duplicate');
    assert.equal(body.results[0].server_received_at, '2026-07-18T15:00:01.000Z');
    const lookup = db.calls.find((call) => call.sql.startsWith('SELECT event_id'));
    assert.deepEqual(lookup.args, [eventId, 'drv_eden']);
  });

  test('refreshes auto-dispatch after an accepted terminal task transition', async () => {
    const order = { id: 9001, status: 'to_dropoff' };
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) return null;
        if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
        if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
          return { stop_id: 'stop_d1', task_type: 'dropoff' };
        }
        if (call.sql === 'SELECT * FROM orders WHERE id = ?') return order;
        if (call.sql.startsWith('SELECT * FROM driver_routes')) {
          return {
            id: 7,
            revision: 13,
            current_stop_id: 'stop_d1',
            plan_fingerprint: 'previous-plan',
          };
        }
        return null;
      },
      all: (call) => call.sql.startsWith('SELECT order_id FROM driver_assignments')
        ? { results: [{ order_id: 9001 }] }
        : { results: [] },
      run: (call) => {
        if (call.sql.startsWith('UPDATE orders SET')) order.status = call.args[0];
        return { meta: { changes: 1 } };
      },
    });
    const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ events: [{
        event_id: eventId,
        event_type: 'delivery_failed',
        occurred_at: '2026-07-18T15:00:00Z',
        recorded_at_monotonic_ms: 42,
        shift_id: 'sh_123',
        order_id: 'ord_9001',
        stop_id: 'stop_d1',
        route_revision_seen: 13,
        payload: {},
      }] }),
    }), { DB: db, AUTO_DRIVER_DISPATCH: 'on' });

    assert.equal((await res.json()).results[0].status, 'accepted');
    assert.equal(order.status, 'failed');
    // Dispatch re-queried the dispatchable orders: the happy-path statuses plus any failed
    // order whose package is still with the driver.
    assert.ok(db.calls.some((call) => call.sql.includes(
      "FROM orders WHERE (status IN ('paid','to_pickup','picked_up','to_dropoff')",
    )));
    assert.ok(db.calls.some((call) => call.sql.includes(
      "OR (status = 'failed' AND retained_by_driver IN ('return_to_origin','hold_for_redelivery'))",
    )));
    assert.ok(db.calls.some((call) => call.sql.startsWith('UPDATE driver_assignments SET active = 0')));
  });

  test('validates the package disposition on a failed delivery without breaking legacy clients', async () => {
    const failureDb = () => {
      const order = { id: 9001, status: 'to_dropoff' };
      const db = fakeDb({
        first: (call) => {
          const auth = authenticatedFirst(call);
          if (auth) return auth;
          if (call.sql.startsWith('SELECT event_id')) return null;
          if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
          if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
          if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
            return { stop_id: 'stop_d1', task_type: 'dropoff' };
          }
          if (call.sql === 'SELECT * FROM orders WHERE id = ?') return order;
          return null;
        },
        run: (call) => {
          if (call.sql.startsWith('UPDATE orders SET')) order.status = call.args[0];
          return { meta: { changes: 1 } };
        },
      });
      return { db, order };
    };
    const send = async (payload) => {
      const { db, order } = failureDb();
      const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ events: [{
          event_id: eventId,
          event_type: 'delivery_failed',
          occurred_at: '2026-07-18T15:00:00Z',
          recorded_at_monotonic_ms: 42,
          shift_id: 'sh_123',
          order_id: 'ord_9001',
          stop_id: 'stop_d1',
          route_revision_seen: 13,
          payload,
        }] }),
      }), { DB: db });
      return { result: (await res.json()).results[0], order, db };
    };

    // Each known disposition is accepted and still closes the order as failed.
    for (const disposition of ['return_to_origin', 'hold_for_redelivery', 'left_with_alternate']) {
      const { result, order } = await send({
        reason: 'incorrect_address',
        disposition,
        note: 'לא ניתן היה למסור',
      });
      assert.equal(result.status, 'accepted', disposition);
      assert.equal(order.status, 'failed', disposition);
    }

    // An unrecognised disposition is a contract defect: refuse it and never touch the
    // order, so the dispatch layer can trust any stored value.
    const unknown = await send({
      reason: 'incorrect_address',
      disposition: 'teleport_home',
      note: 'לא ניתן היה למסור',
    });
    assert.equal(unknown.result.status, 'rejected_invalid');
    assert.equal(unknown.order.status, 'to_dropoff');
    assert.ok(!unknown.db.calls.some((call) => call.sql.startsWith('UPDATE orders SET')));

    // The stable Flutter client reports failures with no disposition at all; that must
    // keep working exactly as before.
    const legacy = await send({});
    assert.equal(legacy.result.status, 'accepted');
    assert.equal(legacy.order.status, 'failed');
  });

  test('records whether a failed delivery left the package with the driver', async () => {
    const send = async (disposition) => {
      const order = { id: 9001, status: 'to_dropoff' };
      const updates = [];
      const db = fakeDb({
        first: (call) => {
          const auth = authenticatedFirst(call);
          if (auth) return auth;
          if (call.sql.startsWith('SELECT event_id')) return null;
          if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
          if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
          if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
            return { stop_id: 'stop_d1', task_type: 'dropoff' };
          }
          if (call.sql === 'SELECT * FROM orders WHERE id = ?') return order;
          return null;
        },
        run: (call) => {
          if (call.sql.startsWith('UPDATE orders SET')) {
            updates.push({ sql: call.sql, args: call.args });
            order.status = call.args[0];
          }
          return { meta: { changes: 1 } };
        },
      });
      const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ events: [{
          event_id: eventId,
          event_type: 'delivery_failed',
          occurred_at: '2026-07-18T15:00:00Z',
          recorded_at_monotonic_ms: 42,
          shift_id: 'sh_123',
          order_id: 'ord_9001',
          stop_id: 'stop_d1',
          route_revision_seen: 13,
          payload: { reason: 'incorrect_address', disposition, note: 'לא ניתן היה למסור' },
        }] }),
      }), { DB: db });
      assert.equal((await res.json()).results[0].status, 'accepted', disposition);
      const update = updates.find((item) => item.sql.includes('retained_by_driver'));
      assert.ok(update, `expected retained_by_driver to be written for ${disposition}`);
      return update.args;
    };

    // The two retained dispositions record custody so dispatch keeps the order live.
    assert.ok((await send('return_to_origin')).includes('return_to_origin'));
    assert.ok((await send('hold_for_redelivery')).includes('hold_for_redelivery'));
    // An alternate handoff released the package, so custody is explicitly cleared.
    assert.ok((await send('left_with_alternate')).includes(null));
  });

  test('a retained return leg can be navigated and closed without jamming the driver', async () => {
    const send = async (eventType, order) => {
      const updates = [];
      const db = fakeDb({
        first: (call) => {
          const auth = authenticatedFirst(call);
          if (auth) return auth;
          if (call.sql.startsWith('SELECT event_id')) return null;
          if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
          if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
          if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
            return { stop_id: 'stop_r9001', task_type: 'dropoff' };
          }
          if (call.sql === 'SELECT * FROM orders WHERE id = ?') return order;
          return null;
        },
        run: (call) => {
          if (call.sql.startsWith('UPDATE orders')) updates.push(call.sql);
          return { meta: { changes: 1 } };
        },
      });
      const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
        body: JSON.stringify({ events: [{
          event_id: eventId,
          event_type: eventType,
          occurred_at: '2026-07-18T15:00:00Z',
          recorded_at_monotonic_ms: 42,
          shift_id: 'sh_123',
          order_id: 'ord_9001',
          stop_id: 'stop_r9001',
          route_revision_seen: 13,
          payload: eventType === 'delivery_failed'
            ? { reason: 'unsafe_access', disposition: 'return_to_origin', note: 'שוב לא הצלחתי' }
            : {},
        }] }),
      }), { DB: db });
      return { result: (await res.json()).results[0], updates, order };
    };
    const retained = () => ({ id: 9001, status: 'failed', retained_by_driver: 'return_to_origin' });

    // Driving to the return stop and arriving must not conflict: an accepted_conflict would
    // make the app block every further action until a full route reload.
    for (const eventType of ['navigation_started', 'arrived']) {
      const { result } = await send(eventType, retained());
      assert.equal(result.status, 'accepted', eventType);
      assert.equal(result.conflict_type ?? null, null, eventType);
    }

    // Handing the package back ends custody but must NOT report the order as delivered —
    // the recipient never received it.
    const completed = await send('delivery_completed', retained());
    assert.equal(completed.result.status, 'accepted');
    assert.ok(completed.updates.some((sql) => sql.includes('retained_by_driver = NULL')));
    assert.ok(!completed.updates.some((sql) => sql.includes("status = 'delivered'")));

    // If the return itself fails, custody must survive: the package is still in the vehicle.
    const failedAgain = await send('delivery_failed', retained());
    assert.equal(failedAgain.result.status, 'accepted');
    assert.ok(!failedAgain.updates.some((sql) => sql.includes('retained_by_driver')));
  });

  test('records a cancelled-order completion as a conflict without changing the order', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) return null;
        if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
        if (call.sql.includes('FROM driver_route_stops s JOIN driver_routes')) {
          return { stop_id: 'stop_d1', task_type: 'dropoff' };
        }
        if (call.sql === 'SELECT * FROM orders WHERE id = ?') return { id: 9001, status: 'cancelled' };
        return null;
      },
    });
    const event = {
      event_id: eventId,
      event_type: 'delivery_completed',
      occurred_at: '2026-07-18T15:00:00Z',
      recorded_at_monotonic_ms: 42,
      shift_id: 'sh_123',
      order_id: 'ord_9001',
      stop_id: 'stop_d1',
      route_revision_seen: 13,
      payload: {},
    };

    const res = await handleDriverApi(request('/api/driver/v1/execution-events:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ events: [event] }),
    }), { DB: db });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.results[0].status, 'accepted_conflict');
    assert.equal(body.results[0].conflict_type, 'order_cancelled');
    assert.ok(!db.calls.some((call) => call.sql.startsWith('UPDATE orders SET')));
    assert.ok(db.calls.some((call) => call.sql.includes('INSERT OR IGNORE INTO driver_execution_events')));
  });

  test('accepts bounded location samples for the active authenticated shift', async () => {
    const now = Date.now();
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.includes('SELECT id, started_at FROM driver_shifts')) {
          return { id: 'sh_123', started_at: now - 60_000 };
        }
        return null;
      },
    });
    const sampleId = '44444444-4444-4444-8444-444444444444';

    const res = await handleDriverApi(request('/api/driver/v1/location:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        shift_id: 'sh_123',
        samples: [{
          sample_id: sampleId,
          captured_at: new Date(now).toISOString(),
          latitude: 32.0809,
          longitude: 34.7806,
          accuracy_meters: 12,
          speed_meters_per_second: 4.5,
        }],
      }),
    }), { DB: db });

    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted_count: 1 });
    const insert = db.calls.find((call) => call.sql.includes('INSERT OR IGNORE INTO driver_location_samples'));
    assert.ok(insert);
    assert.deepEqual(insert.args.slice(0, 3), [sampleId, 'drv_eden', 'sh_123']);
    assert.ok(db.calls.some((call) => call.sql.startsWith('DELETE FROM driver_location_samples')));
  });

  test('rejects stale or inaccurate location samples without persisting them', async () => {
    const now = Date.now();
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.includes('SELECT id, started_at FROM driver_shifts')) {
          return { id: 'sh_123', started_at: now - 60_000 };
        }
        return null;
      },
    });

    const res = await handleDriverApi(request('/api/driver/v1/location:batch', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        shift_id: 'sh_123',
        samples: [{
          sample_id: '55555555-5555-4555-8555-555555555555',
          captured_at: new Date(now - 120_000).toISOString(),
          latitude: 32.0809,
          longitude: 34.7806,
          accuracy_meters: 1001,
        }],
      }),
    }), { DB: db });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid_location_samples');
    assert.ok(!db.calls.some((call) => call.sql.includes('INSERT OR IGNORE INTO driver_location_samples')));
  });
});
