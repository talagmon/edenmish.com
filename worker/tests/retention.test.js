import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRetentionCleanup, runHeldPackageAutoReturn } from '../src/db.js';

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

test('held-package auto-return reverts only stale holds and always resolves them', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
          return { run: async () => ({ meta: { changes: 1 } }) };
        }
      };
    }
  };
  const now = Date.UTC(2026, 6, 12);
  await runHeldPackageAutoReturn(DB, now);

  const call = calls[0];
  // It only touches failed orders still held for redelivery — never a return already resolving,
  // and never a live order.
  assert.match(call.sql, /status = 'failed'/);
  assert.match(call.sql, /retained_by_driver = 'hold_for_redelivery'/);
  // And it converts to a return (dispatched without a payment gate), so the package is never
  // left stuck; retained_at is reset so the new return is timestamped fresh.
  assert.match(call.sql, /SET retained_by_driver = 'return_to_origin', retained_at = \?/);
  // The 24h cutoff.
  assert.equal(call.values[0], now);
  assert.equal(call.values[1], now - 24 * 60 * 60 * 1000);
});
