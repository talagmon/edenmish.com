import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  applyBusinessDeliveryException,
  attachBusinessDeliveryExceptionToOrder,
  claimBusinessDeliveryException,
  findBusinessDeliveryException,
} from '../src/business-delivery-exceptions.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const databases = [];

afterEach(() => {
  while (databases.length) databases.pop().close();
});

function d1Database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  databases.push(sqlite);
  const wrap = (statement) => {
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() { return statement.get(...values) || null; },
      async run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  };
  return {
    sqlite,
    prepare(sql) { return wrap(sqlite.prepare(sql)); },
  };
}

function seedException(DB, overrides = {}) {
  const now = 2_000_000_000_000;
  DB.sqlite.prepare(`INSERT INTO business_accounts
      (id, company_name, plan_id, rate_plan_version, status, created_at, updated_at)
      VALUES (7, 'Exception Test', 'gold', 'test', 'active', ?, ?)`)
    .run(now, now);
  DB.sqlite.prepare(`INSERT INTO business_delivery_exceptions
      (account_id, external_id, zone, service, price_agorot, expires_at, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      7,
      overrides.external_id || 'RH2026-003',
      overrides.zone || 3,
      overrides.service || 'standard',
      overrides.price_agorot || 11_500,
      overrides.expires_at || now + 60_000,
      'one-use test exception',
      now,
    );
  return now;
}

test('finds and applies only the exact account, row, zone and service exception', async () => {
  const DB = d1Database();
  const now = seedException(DB);
  const input = {
    accountId: 7,
    externalId: 'RH2026-003',
    zone: 3,
    service: 'standard',
    idempotencyKey: 'batch:rh2026-003',
    now,
  };
  const exception = await findBusinessDeliveryException(DB, input);
  assert.equal(exception.price_agorot, 11_500);
  assert.equal(await findBusinessDeliveryException(DB, { ...input, accountId: 8 }), null);
  assert.equal(await findBusinessDeliveryException(DB, { ...input, externalId: 'RH2026-004' }), null);
  assert.equal(await findBusinessDeliveryException(DB, { ...input, service: 'eco' }), null);

  const quote = applyBusinessDeliveryException({
    zone: 3,
    service: 'standard',
    price: 115,
    review: true,
    available: false,
    reasons: ['plan_service_unavailable'],
    breakdown: { base: 115, total: 115 },
  }, 'gold', exception);
  assert.equal(quote.available, true);
  assert.equal(quote.review, false);
  assert.equal(quote.price, 115);
  assert.equal(quote.exception_applied, true);
  assert.deepEqual(quote.reasons, []);
  assert.deepEqual(
    applyBusinessDeliveryException({ available: true, review: false, price: 65 }, 'gold', exception),
    { available: true, review: false, price: 65 },
  );
});

test('claims once, permits the same idempotent retry, and rejects a different key', async () => {
  const DB = d1Database();
  const now = seedException(DB);
  const input = {
    accountId: 7,
    externalId: 'RH2026-003',
    zone: 3,
    service: 'standard',
    idempotencyKey: 'batch:rh2026-003',
    now,
  };
  const first = await claimBusinessDeliveryException(DB, input);
  assert.equal(first.claimed, true);
  assert.equal(first.exception.consumed_key, input.idempotencyKey);
  const retry = await claimBusinessDeliveryException(DB, { ...input, now: now + 1 });
  assert.equal(retry.claimed, true);
  assert.equal(retry.exception.consumed_at, now);
  const other = await claimBusinessDeliveryException(DB, {
    ...input,
    idempotencyKey: 'batch:other',
    now: now + 2,
  });
  assert.equal(other.claimed, false);

  DB.sqlite.prepare(`INSERT INTO orders (token, status, created_at)
    VALUES ('exception-order', 'paid', ?)`)
    .run(now);
  const order = DB.sqlite.prepare('SELECT id FROM orders WHERE token = ?').get('exception-order');
  const attached = await attachBusinessDeliveryExceptionToOrder(DB, {
    accountId: 7,
    externalId: 'RH2026-003',
    idempotencyKey: input.idempotencyKey,
    orderId: order.id,
  });
  assert.equal(attached.attached, true);
  assert.equal(DB.sqlite.prepare(
    'SELECT order_id FROM business_delivery_exceptions WHERE account_id = 7'
  ).get().order_id, order.id);
});

test('does not expose an expired exception', async () => {
  const DB = d1Database();
  const now = seedException(DB, { expires_at: 1_999_999_999_999 });
  const exception = await findBusinessDeliveryException(DB, {
    accountId: 7,
    externalId: 'RH2026-003',
    zone: 3,
    service: 'standard',
    idempotencyKey: 'batch:rh2026-003',
    now,
  });
  assert.equal(exception, null);
});
