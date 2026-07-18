import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleDriverApi } from '../src/driver-api.js';

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
  return {
    calls,
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

  test('returns a revisioned route snapshot with Hebrew customer data intact', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql === 'SELECT id FROM driver_shifts WHERE id = ? AND driver_id = ?') return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_routes')) return {
          id: 7,
          revision: 12,
          generated_at: Date.parse('2026-07-18T15:31:22Z'),
          reason: 'new_order_inserted',
          current_stop_id: 'stop_41',
          current_stop_locked: 1,
          delay_minutes: 6,
          current_position: 2,
          total_stops: 5,
        };
        return null;
      },
      all: (call) => call.sql.includes('FROM driver_route_stops') ? { results: [{
        stop_id: 'stop_41', order_id: 9001, position: 2, state: 'navigating',
        name: 'נועה לוי', phone: '+972541234567', dropoff: 'הרצל 42, תל אביב',
        dropoff_lat: 32.0632, dropoff_lng: 34.7708,
        promised_from: '2026-07-18T15:00:00Z', promised_to: '2026-07-18T16:00:00Z',
        eta: '2026-07-18T15:35:00Z', urgency: 'normal', inserted: 1,
      }] } : { results: [] },
    });

    const res = await handleDriverApi(request('/api/driver/v1/shifts/sh_123/route', {
      headers: { authorization: 'Bearer valid-token' },
    }), { DB: db });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"route-sh_123-12"');
    assert.equal(body.revision, 12);
    assert.equal(body.stops[0].customer.display_name, 'נועה לוי');
    assert.deepEqual(body.change_summary.added_stop_ids, ['stop_41']);
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

  test('records a cancelled-order completion as a conflict without changing the order', async () => {
    const db = fakeDb({
      first: (call) => {
        const auth = authenticatedFirst(call);
        if (auth) return auth;
        if (call.sql.startsWith('SELECT event_id')) return null;
        if (call.sql.includes('FROM driver_shifts WHERE id')) return { id: 'sh_123' };
        if (call.sql.includes('FROM driver_assignments')) return { order_id: 9001 };
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
      stop_id: 'stop_41',
      route_revision_seen: 12,
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
});
