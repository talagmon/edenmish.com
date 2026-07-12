import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRetentionCleanup } from '../src/db.js';

test('retention cleanup applies bounded periods without deleting core orders', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return { run: async () => ({ success: true }) };
        }
      };
    }
  };
  const now = Date.UTC(2026, 6, 12);
  await runRetentionCleanup(DB, now);
  assert.equal(calls.length, 5);
  assert.match(calls[0].sql, /DELETE FROM gps_pings/);
  assert.equal(calls[0].values[0], now - 30 * 86400000);
  assert.match(calls[1].sql, /UPDATE delivery_proofs/);
  assert.equal(calls[1].values[0], now - 90 * 86400000);
  assert.match(calls[2].sql, /DELETE FROM notifications/);
  assert.match(calls[3].sql, /DELETE FROM cancellation_requests/);
  assert.ok(calls.every(({ sql }) => !/DELETE FROM orders/.test(sql)));
});
