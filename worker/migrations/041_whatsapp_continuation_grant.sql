-- Explicit versioned continuation; never rewrites the original stopped ledger.
-- One grant per original run, no chat/phone/key data, no retention cleanup.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=1),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=1800000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=300000),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=500000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 180000),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 10),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 10),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 3),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 6),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_micros+model_micros<=500000),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2000000)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_operations_grant ON whatsapp_continuation_operations(grant_id,kind);
