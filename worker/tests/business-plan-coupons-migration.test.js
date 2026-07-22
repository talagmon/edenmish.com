import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, '../migrations/022_business_plan_coupons.sql'), 'utf8');

test('migration 022 adds scoped business coupons without changing package credit', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE coupons (
      code TEXT PRIMARY KEY, title TEXT, value_type TEXT, value REAL NOT NULL,
      status TEXT, starts_at INTEGER, ends_at INTEGER, usage_limit INTEGER,
      applies_once_per_customer INTEGER DEFAULT 0, synced_at INTEGER
    );
    CREATE TABLE wallet_topups (
      id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, plan_id TEXT NOT NULL,
      amount_agorot INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'ILS',
      status TEXT NOT NULL DEFAULT 'created', created_at INTEGER NOT NULL
    );
    INSERT INTO wallet_topups (id,account_id,plan_id,amount_agorot,status,created_at)
    VALUES ('legacy',1,'gold',150000,'paid',1);
  `);
  db.exec(migration);

  const couponColumns = db.prepare("SELECT name FROM pragma_table_info('coupons') WHERE name IN ('scope','business_plan_ids') ORDER BY name").all().map(({ name }) => name);
  const topupColumns = db.prepare("SELECT name FROM pragma_table_info('wallet_topups') WHERE name IN ('payment_amount_agorot','discount_code','discount_amount_agorot','discount_title') ORDER BY name").all().map(({ name }) => name);
  assert.deepEqual(couponColumns, ['business_plan_ids', 'scope']);
  assert.deepEqual(topupColumns, ['discount_amount_agorot', 'discount_code', 'discount_title', 'payment_amount_agorot']);
  assert.equal(db.prepare("SELECT payment_amount_agorot FROM wallet_topups WHERE id='legacy'").get().payment_amount_agorot, 150000);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='business_coupon_redemptions'").get());
});

test('deployment workflows require migration 022 before enabling the feature', () => {
  const staging = readFileSync(resolve(here, '../../.github/workflows/staging-worker.yml'), 'utf8');
  const production = readFileSync(resolve(here, '../../.github/workflows/production-deploy.yml'), 'utf8');
  assert.match(staging, /022_business_plan_coupons\.sql/);
  assert.match(production, /022_business_plan_coupons\.sql/);
});
