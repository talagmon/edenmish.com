-- Account-scoped, customer-approved spreadsheet header mappings.
-- Only a SHA-256 header signature and canonical column indexes are stored.
CREATE TABLE IF NOT EXISTS business_batch_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  header_signature TEXT NOT NULL CHECK(length(header_signature) = 64),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
  UNIQUE(account_id, header_signature),
  FOREIGN KEY (account_id) REFERENCES business_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_business_batch_mappings_account
  ON business_batch_mappings(account_id, updated_at DESC);
