-- Account-scoped, one-use exceptions for a specific business batch delivery.
-- The deterministic batch idempotency key consumes the exception once while
-- allowing safe retries of the same logical delivery.
CREATE TABLE IF NOT EXISTS business_delivery_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 80),
  zone INTEGER NOT NULL CHECK(zone IN (1, 2, 3)),
  service TEXT NOT NULL CHECK(service IN ('eco', 'standard', 'flash')),
  price_agorot INTEGER NOT NULL CHECK(price_agorot > 0),
  expires_at INTEGER NOT NULL,
  consumed_key TEXT CHECK(consumed_key IS NULL OR length(consumed_key) BETWEEN 1 AND 120),
  consumed_at INTEGER,
  order_id INTEGER,
  note TEXT CHECK(note IS NULL OR length(note) <= 240),
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, external_id),
  CHECK(
    (consumed_key IS NULL AND consumed_at IS NULL)
    OR (consumed_key IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  FOREIGN KEY (account_id) REFERENCES business_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_business_delivery_exceptions_lookup
  ON business_delivery_exceptions(account_id, external_id, zone, service, expires_at);
