-- Migration 021: Make Trial and Business Wallet first-class account plans.
-- Rebuilds the three plan-constrained tables while preserving all existing data.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE business_accounts_plan_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT,
  plan_id TEXT CHECK(plan_id IN ('trial','wallet','silver','gold','platinum')),
  rate_plan_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO business_accounts_plan_v2
  (id, company_name, plan_id, rate_plan_version, status, created_at, updated_at)
SELECT id, company_name, plan_id, rate_plan_version, status, created_at, updated_at
FROM business_accounts;
DROP TABLE business_accounts;
ALTER TABLE business_accounts_plan_v2 RENAME TO business_accounts;

CREATE TABLE wallet_topups_plan_v2 (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('trial','wallet','silver','gold','platinum')),
  amount_agorot INTEGER NOT NULL CHECK(amount_agorot > 0),
  currency TEXT NOT NULL DEFAULT 'ILS',
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','checkout_ready','paid','mismatch','cancelled')),
  shopify_draft_order_id TEXT,
  shopify_order_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES business_accounts(id)
);
INSERT INTO wallet_topups_plan_v2
  (id, account_id, plan_id, amount_agorot, currency, status,
   shopify_draft_order_id, shopify_order_id, checkout_url, created_at, paid_at)
SELECT id, account_id, plan_id, amount_agorot, currency, status,
       shopify_draft_order_id, shopify_order_id, checkout_url, created_at, paid_at
FROM wallet_topups;
DROP TABLE wallet_topups;
ALTER TABLE wallet_topups_plan_v2 RENAME TO wallet_topups;
CREATE INDEX idx_wallet_topups_account ON wallet_topups(account_id, created_at DESC);
CREATE UNIQUE INDEX idx_wallet_topups_trial_once
  ON wallet_topups(account_id)
  WHERE plan_id = 'trial' AND status IN ('created','checkout_ready','paid');

CREATE TABLE business_plan_enrollments_plan_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('trial','wallet','silver','gold','platinum')),
  rate_plan_version TEXT NOT NULL,
  topup_id TEXT NOT NULL UNIQUE,
  starts_at INTEGER NOT NULL,
  credit_expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES business_accounts(id),
  FOREIGN KEY (topup_id) REFERENCES wallet_topups(id)
);
INSERT INTO business_plan_enrollments_plan_v2
  (id, account_id, plan_id, rate_plan_version, topup_id, starts_at, credit_expires_at)
SELECT id, account_id, plan_id, rate_plan_version, topup_id, starts_at, credit_expires_at
FROM business_plan_enrollments;
DROP TABLE business_plan_enrollments;
ALTER TABLE business_plan_enrollments_plan_v2 RENAME TO business_plan_enrollments;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
