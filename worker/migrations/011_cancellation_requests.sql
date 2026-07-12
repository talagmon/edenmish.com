-- Migration 011: durable online cancellation notices (Consumer Protection Law §14ט).
-- Store only the last four identity digits; the full number is forwarded to the
-- business in the cancellation email and is not persisted in D1.

CREATE TABLE IF NOT EXISTS cancellation_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  identity_last4 TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cancellation_requests_status
  ON cancellation_requests(status, created_at DESC);
