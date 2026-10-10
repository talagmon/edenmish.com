-- Bounded staging pilot only. No message bodies, addresses, phone numbers or keys.
CREATE TABLE IF NOT EXISTS whatsapp_pilot_budgets (
  pilot_id TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  started_at INTEGER,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
  charged_micros INTEGER NOT NULL DEFAULT 0 CHECK(charged_micros BETWEEN 0 AND 500000),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_pilot_model_attempts (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL REFERENCES whatsapp_pilot_budgets(pilot_id),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  charged_micros INTEGER NOT NULL CHECK(charged_micros BETWEEN 0 AND 300000),
  input_tokens INTEGER,
  output_tokens INTEGER,
  outcome TEXT,
  readiness_case TEXT,
  http_status INTEGER,
  elapsed_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS whatsapp_pilot_model_attempts_pilot ON whatsapp_pilot_model_attempts(pilot_id, created_at);
