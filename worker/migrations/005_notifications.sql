-- 005: Notification audit trail (PR8). Idempotent — safe on a fresh DB (where
-- schema.sql already created it) and on existing DBs. One row per notification
-- attempt. Never stores the body/html or OTP codes — only metadata + outcome.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  channel TEXT NOT NULL,
  template TEXT,
  recipient TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  provider_ref TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, id DESC);
