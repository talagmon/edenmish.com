import { test, describe } from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';

function cancellationDb() {
  const state = { cancellationArgs: null };
  return {
    state,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT count, window_start')) return null;
              if (sql.includes('INSERT INTO cancellation_requests')) {
                state.cancellationArgs = args;
                return { id: 42, created_at: 1_784_000_000_000 };
              }
              if (sql.includes('INSERT INTO notifications')) return { id: 7 };
              return null;
            },
            async run() { return { success: true }; },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

function request(body, ip = '10.1.1.1') {
  return new Request('https://find.edenmish.com/api/cancellations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

const validBody = {
  order_number: '1234',
  customer_name: 'ישראל ישראלי',
  identity_number: '039284286',
  email: 'customer@example.com',
  phone: '054-123-4567',
  reason: 'מבקש לבטל את העסקה',
};

describe('POST /api/cancellations', () => {
  test('durably accepts a valid notice and does not persist the full identity number', async () => {
    const db = cancellationDb();
    const res = await worker.fetch(request(validBody), { DB: db, SESSION_SECRET: 'test-secret' });
    const data = await res.json();

    assert.equal(res.status, 201);
    assert.deepEqual(data, { ok: true, reference: 42, received_at: 1_784_000_000_000 });
    assert.equal(db.state.cancellationArgs[2], '4286');
    assert.ok(!db.state.cancellationArgs.includes(validBody.identity_number));
  });

  test('rejects an invalid identity checksum before storage', async () => {
    const db = cancellationDb();
    const res = await worker.fetch(request({ ...validBody, identity_number: '039284287' }, '10.1.1.2'), { DB: db, SESSION_SECRET: 'test-secret' });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_identity');
    assert.equal(db.state.cancellationArgs, null);
  });
});
