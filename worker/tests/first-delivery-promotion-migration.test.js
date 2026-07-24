import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  findAutomaticCoupon,
  listCoupons,
  reserveFirstDeliveryClaim,
  validateCoupon,
} from '../src/coupons.js';

const migration = readFileSync(
  new URL('../migrations/031_first_delivery_promotion.sql', import.meta.url),
  'utf8',
);
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const stagingWorkflow = readFileSync(
  new URL('../../.github/workflows/staging-worker.yml', import.meta.url),
  'utf8',
);
const productionWorkflow = readFileSync(
  new URL('../../.github/workflows/production-deploy.yml', import.meta.url),
  'utf8',
);

const openDatabases = [];
afterEach(() => {
  while (openDatabases.length) openDatabases.pop().close();
});

function d1(sqlite) {
  const wrap = (statement) => {
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  };
  return {
    prepare(sql) { return wrap(sqlite.prepare(sql)); },
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

function latestPre031Fixture() {
  const sqlite = new DatabaseSync(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      email TEXT,
      payment_status TEXT,
      business_account_id INTEGER
    );
    CREATE TABLE business_accounts (id INTEGER PRIMARY KEY);
    CREATE TABLE coupons (
      code TEXT PRIMARY KEY,
      shopify_discount_id TEXT,
      title TEXT,
      value_type TEXT CHECK(value_type IN ('percentage','fixed_amount')),
      value REAL NOT NULL,
      status TEXT,
      starts_at INTEGER,
      ends_at INTEGER,
      usage_limit INTEGER,
      applies_once_per_customer INTEGER DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'delivery' CHECK(scope IN ('delivery','business_plan')),
      business_plan_ids TEXT,
      synced_at INTEGER,
      raw_shopify_json TEXT
    );
    CREATE TABLE coupon_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      customer_key TEXT,
      price_before INTEGER,
      discount_amount INTEGER,
      price_after INTEGER,
      created_at INTEGER
    );
  `);
  return sqlite;
}

test('migration 031 upgrades the latest pre-031 coupon and business-order schema', () => {
  const sqlite = latestPre031Fixture();
  sqlite.exec(migration);

  assert.deepEqual(
    sqlite.prepare(
      `SELECT name FROM pragma_table_info('coupons')
       WHERE name IN ('auto_apply','eligibility_rule') ORDER BY name`
    ).all().map(({ name }) => name),
    ['auto_apply', 'eligibility_rule'],
  );
  assert.ok(sqlite.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name='first_delivery_promotion_claims'`
  ).get());
  assert.equal(sqlite.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type='index' AND name IN (
       'idx_coupon_redemptions_promotion_claim',
       'idx_first_delivery_claim_phone',
       'idx_first_delivery_claim_email',
       'idx_first_delivery_claim_business',
       'idx_first_delivery_claim_business_idempotency'
     )`
  ).get().count, 5);

  const launch = sqlite.prepare(
    `SELECT value, auto_apply, eligibility_rule, scope,
            applies_once_per_customer, ends_at
     FROM coupons WHERE code='FIRST10-2026'`
  ).get();
  assert.deepEqual({ ...launch }, {
    value: 10,
    auto_apply: 1,
    eligibility_rule: 'first_delivery',
    scope: 'delivery',
    applies_once_per_customer: 1,
    ends_at: 1788209999999,
  });
});

test('private eligibility checks both normalized identities and the inclusive end instant', async () => {
  const sqlite = new DatabaseSync(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(schema);
  const DB = d1(sqlite);
  const identity = {
    customerKey: '+972541234567',
    phoneKey: '+972541234567',
    emailKey: 'new@example.com',
    customerType: 'private',
  };

  let promotion = await findAutomaticCoupon(DB, 50, identity, { now: 1788209999999 });
  assert.equal(promotion.valid, true);
  assert.equal(promotion.price, 45);
  assert.equal(promotion.discountAmount, 5);

  assert.deepEqual(
    await validateCoupon(DB, 'FIRST10-2026', 50, identity, { now: 1788210000000 }),
    { valid: false, reason: 'expired' },
  );

  sqlite.prepare(
    `INSERT INTO orders (token, status, phone, email, payment_status, created_at)
     VALUES ('prior-private', 'paid', '+972500000000', 'NEW@example.com', 'paid', 1)`
  ).run();
  promotion = await validateCoupon(DB, 'FIRST10-2026', 50, identity, { now: 1788209999999 });
  assert.deepEqual(promotion, { valid: false, reason: 'not_new_customer' });
});

test('business eligibility uses authenticated account identity and blocks wallet-paid history', async () => {
  const sqlite = new DatabaseSync(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(schema);
  const DB = d1(sqlite);
  const identity = {
    customerKey: 'business:77',
    phoneKey: '+972541234567',
    emailKey: 'owner@example.com',
    businessAccountId: 77,
    customerType: 'business',
  };

  assert.equal((await findAutomaticCoupon(DB, 45, identity)).price, 40);
  sqlite.prepare(
    `INSERT INTO orders
      (token, status, phone, email, payment_status, business_account_id, created_at)
     VALUES ('prior-wallet', 'delivered', '+972500000000', 'other@example.com',
             'wallet_paid', 77, 1)`
  ).run();
  assert.deepEqual(
    await validateCoupon(DB, 'FIRST10-2026', 45, identity),
    { valid: false, reason: 'not_new_customer' },
  );
});

test('first-delivery claims are atomic and business idempotency reuses one claim', async () => {
  const sqlite = new DatabaseSync(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(schema);
  sqlite.prepare(
    `INSERT INTO business_accounts
      (id, company_name, status, created_at, updated_at)
     VALUES (9, 'Claim Test', 'active', 1, 1)`
  ).run();
  const DB = d1(sqlite);
  const identity = {
    customerKey: 'business:9',
    phoneKey: '+972541111111',
    emailKey: 'first@business.example',
    businessAccountId: 9,
    customerType: 'business',
  };
  const coupon = await findAutomaticCoupon(DB, 45, identity);

  const first = await reserveFirstDeliveryClaim(DB, {
    coupon,
    identity,
    idempotencyKey: 'business-order-1',
  });
  const retry = await reserveFirstDeliveryClaim(DB, {
    coupon,
    identity,
    idempotencyKey: 'business-order-1',
  });
  const competing = await reserveFirstDeliveryClaim(DB, {
    coupon,
    identity,
    idempotencyKey: 'business-order-2',
  });

  assert.equal(first.reserved, true);
  assert.equal(first.unchanged, false);
  assert.equal(retry.reserved, true);
  assert.equal(retry.unchanged, true);
  assert.equal(retry.claim.id, first.claim.id);
  assert.deepEqual(competing, { reserved: false, reason: 'not_new_customer' });
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM first_delivery_promotion_claims').get().count,
    1,
  );
  const launch = (await listCoupons(DB)).find(({ code }) => code === 'FIRST10-2026');
  assert.equal(launch.redemption_count, 1);
});

test('deployment checklists reference migration 031 without running it', () => {
  assert.match(stagingWorkflow, /031_first_delivery_promotion\.sql/);
  assert.match(productionWorkflow, /031_first_delivery_promotion\.sql/);
});
