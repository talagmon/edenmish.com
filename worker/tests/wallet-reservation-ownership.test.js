import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../migrations/025_wallet_reservation_ownership.sql', import.meta.url),
  'utf8',
);
const stagingWorkflow = readFileSync(
  new URL('../../.github/workflows/staging-worker.yml', import.meta.url),
  'utf8',
);
const productionWorkflow = readFileSync(
  new URL('../../.github/workflows/production-deploy.yml', import.meta.url),
  'utf8',
);

function d1Database({ synchronizeWalletLookup = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);

  let walletLookupCount = 0;
  let releaseWalletLookups;
  const walletLookupBarrier = new Promise((resolve) => { releaseWalletLookups = resolve; });

  const wrap = (statement, sql) => {
    let values = [];
    return {
      bind(...bound) {
        values = bound;
        return this;
      },
      async first() {
        if (
          synchronizeWalletLookup &&
          /SELECT \* FROM wallet_reservations WHERE account_id = \? AND idempotency_key = \?/.test(sql) &&
          walletLookupCount < 2
        ) {
          walletLookupCount += 1;
          if (walletLookupCount === 2) releaseWalletLookups();
          await walletLookupBarrier;
        }
        return statement.get(...values) || null;
      },
      async all() {
        return { results: statement.all(...values) };
      },
      async run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  };

  return {
    sqlite,
    prepare(sql) {
      return wrap(sqlite.prepare(sql), sql);
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://find.edenmish.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.20',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function createBusinessSession(env) {
  let response = await worker.fetch(
    post('/api/business/auth/request', { email: 'wallet-owner@example.com', plan_id: 'gold' }),
    env,
  );
  assert.equal(response.status, 200);
  const challenge = await response.json();
  assert.ok(challenge.challenge);
  assert.match(challenge.test_code, /^\d{6}$/);

  response = await worker.fetch(
    post('/api/business/auth/verify', {
      challenge: challenge.challenge,
      code: challenge.test_code,
    }),
    env,
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^business_session=/);
  return cookie.split(';', 1)[0];
}

const orderBody = {
  use_wallet: true,
  phone: '054-123-4567',
  pickup: 'דיזנגוף 1, תל אביב',
  dropoff: 'ביאליק 2, רמת גן',
  pickup_city: 'תל אביב',
  dropoff_city: 'רמת גן',
  service: 'standard',
  size: 'small',
  when_text: '10:00-12:00 · 27/07',
  when_date: '2026-07-27',
  when_hour: 10,
};

const openDatabases = [];
afterEach(() => {
  while (openDatabases.length) openDatabases.pop().close();
});

describe('wallet reservation ownership', () => {
  test('two concurrent API requests with one idempotency key return one wallet-backed order', async () => {
    const DB = d1Database({ synchronizeWalletLookup: true });
    openDatabases.push(DB.sqlite);
    const env = {
      DB,
      SESSION_SECRET: 'wallet-test-session-secret',
      TEST_MODE: '1',
    };
    const cookie = await createBusinessSession(env);
    const account = DB.sqlite.prepare('SELECT id FROM business_accounts LIMIT 1').get();
    const now = Date.now();
    DB.sqlite.prepare(
      `UPDATE business_accounts
       SET company_name = 'Wallet Test', plan_id = 'gold', updated_at = ?
       WHERE id = ?`
    ).run(now, account.id);
    DB.sqlite.prepare(
      `UPDATE business_wallets
       SET available_agorot = 100000, reserved_agorot = 0, updated_at = ?
       WHERE account_id = ?`
    ).run(now, account.id);
    DB.sqlite.prepare(
      `INSERT INTO wallet_credit_lots
       (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
       VALUES (?, 'wallet-test-credit', 100000, 100000, ?, ?)`
    ).run(account.id, now + 30 * 24 * 60 * 60 * 1000, now);

    const headers = {
      Cookie: cookie,
      'Idempotency-Key': 'same-business-booking',
    };
    const [first, second] = await Promise.all([
      worker.fetch(post('/api/orders', orderBody, headers), env),
      worker.fetch(post('/api/orders', orderBody, headers), env),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const responses = await Promise.all([first.json(), second.json()]);
    assert.equal(responses[0].order_id, responses[1].order_id);
    assert.equal(responses.filter(({ idempotent }) => idempotent === true).length, 1);

    const orders = DB.sqlite.prepare(
      `SELECT id, wallet_reservation_id, payment_status, payment_method
       FROM orders WHERE business_account_id = ?`
    ).all(account.id);
    const reservations = DB.sqlite.prepare(
      `SELECT id, order_id, status FROM wallet_reservations WHERE account_id = ?`
    ).all(account.id);
    const wallet = DB.sqlite.prepare(
      'SELECT available_agorot, reserved_agorot FROM business_wallets WHERE account_id = ?'
    ).get(account.id);
    const reserveEntries = DB.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM wallet_entries
       WHERE account_id = ? AND entry_type = 'reserve'`
    ).get(account.id);

    assert.equal(orders.length, 1);
    assert.equal(reservations.length, 1);
    assert.equal(orders[0].wallet_reservation_id, reservations[0].id);
    assert.equal(reservations[0].order_id, orders[0].id);
    assert.equal(orders[0].payment_status, 'wallet_reserved');
    assert.equal(orders[0].payment_method, 'wallet');
    assert.equal(reservations[0].status, 'reserved');
    assert.equal(reserveEntries.count, 1);
    assert.ok(wallet.available_agorot < 100000);
    assert.ok(wallet.reserved_agorot > 0);
    assert.equal(wallet.available_agorot + wallet.reserved_agorot, 100000);
  });

  test('migration creates a partial unique index for non-null reservation references', () => {
    const sqlite = new DatabaseSync(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, wallet_reservation_id TEXT)');
    sqlite.exec(migration);
    sqlite.prepare('INSERT INTO orders VALUES (?, ?)').run(1, 'reservation-1');
    assert.throws(
      () => sqlite.prepare('INSERT INTO orders VALUES (?, ?)').run(2, 'reservation-1'),
      /UNIQUE constraint failed/,
    );
    sqlite.prepare('INSERT INTO orders VALUES (?, ?)').run(3, null);
    sqlite.prepare('INSERT INTO orders VALUES (?, ?)').run(4, null);
  });

  test('migration fails closed when historical duplicate references need review', () => {
    const sqlite = new DatabaseSync(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, wallet_reservation_id TEXT)');
    sqlite.prepare('INSERT INTO orders VALUES (?, ?)').run(1, 'duplicate-reservation');
    sqlite.prepare('INSERT INTO orders VALUES (?, ?)').run(2, 'duplicate-reservation');
    assert.throws(() => sqlite.exec(migration), /UNIQUE constraint failed/);
    const index = sqlite.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_orders_wallet_reservation_unique'`
    ).get();
    assert.equal(index, undefined);
  });

  test('deployment workflows require migration 025 before protected runtime behavior', () => {
    assert.match(stagingWorkflow, /025_wallet_reservation_ownership\.sql/);
    assert.match(stagingWorkflow, /duplicate_count/);
    assert.match(stagingWorkflow, /idx_orders_wallet_reservation_unique/);
    assert.match(productionWorkflow, /025_wallet_reservation_ownership\.sql/);
  });
});
