-- Migration 020: Idempotent repair for partially applied business wallet schema.
-- Table and index creation only. Migration 018 remains the owner of orders columns.

CREATE TABLE IF NOT EXISTS business_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  phone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT,
  plan_id TEXT CHECK(plan_id IN ('silver','gold','platinum')),
  rate_plan_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_members (
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','staff')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (account_id) REFERENCES business_accounts(id),
  FOREIGN KEY (user_id) REFERENCES business_users(id)
);

CREATE TABLE IF NOT EXISTS business_auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_auth_email
  ON business_auth_challenges(email, created_at DESC);

CREATE TABLE IF NOT EXISTS business_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES business_users(id)
);
CREATE INDEX IF NOT EXISTS idx_business_sessions_expiry
  ON business_sessions(expires_at);

CREATE TABLE IF NOT EXISTS business_wallets (
  account_id INTEGER PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'ILS',
  available_agorot INTEGER NOT NULL DEFAULT 0 CHECK(available_agorot >= 0),
  reserved_agorot INTEGER NOT NULL DEFAULT 0 CHECK(reserved_agorot >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES business_accounts(id)
);

CREATE TABLE IF NOT EXISTS wallet_topups (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('silver','gold','platinum')),
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
CREATE INDEX IF NOT EXISTS idx_wallet_topups_account
  ON wallet_topups(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_credit_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  topup_id TEXT NOT NULL UNIQUE,
  original_agorot INTEGER NOT NULL CHECK(original_agorot > 0),
  remaining_agorot INTEGER NOT NULL CHECK(remaining_agorot >= 0),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES business_accounts(id),
  FOREIGN KEY (topup_id) REFERENCES wallet_topups(id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_lots_fifo
  ON wallet_credit_lots(account_id, expires_at, id);

CREATE TABLE IF NOT EXISTS wallet_reservations (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  order_id INTEGER UNIQUE,
  idempotency_key TEXT NOT NULL,
  amount_agorot INTEGER NOT NULL CHECK(amount_agorot > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','captured','released')),
  created_at INTEGER NOT NULL,
  captured_at INTEGER,
  released_at INTEGER,
  UNIQUE(account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES business_accounts(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_reservations_account
  ON wallet_reservations(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('topup','reserve','capture','release','refund','expiry','adjustment')),
  available_delta_agorot INTEGER NOT NULL DEFAULT 0,
  reserved_delta_agorot INTEGER NOT NULL DEFAULT 0,
  topup_id TEXT,
  reservation_id TEXT,
  order_id INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES business_accounts(id),
  FOREIGN KEY (topup_id) REFERENCES wallet_topups(id),
  FOREIGN KEY (reservation_id) REFERENCES wallet_reservations(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_account
  ON wallet_entries(account_id, id DESC);

CREATE TABLE IF NOT EXISTS business_plan_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('silver','gold','platinum')),
  rate_plan_version TEXT NOT NULL,
  topup_id TEXT NOT NULL UNIQUE,
  starts_at INTEGER NOT NULL,
  credit_expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES business_accounts(id),
  FOREIGN KEY (topup_id) REFERENCES wallet_topups(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_business_account
  ON orders(business_account_id, created_at DESC);
