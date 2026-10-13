-- One explicitly approved second window, only after an unused expired v1 grant.
-- Original tables are untouched; original historical holds/cushion apply once.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_followon_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=2),
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
CREATE TABLE IF NOT EXISTS whatsapp_continuation_followon_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_followon_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_followon_operations_grant ON whatsapp_continuation_followon_operations(grant_id,kind);

-- Reject issuance races or an attempt to carry unrecorded predecessor spend.
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_unused_predecessor
BEFORE INSERT ON whatsapp_continuation_followon_grants
WHEN NOT EXISTS (
  SELECT 1 FROM whatsapp_continuation_grants p
  WHERE p.pilot_id=NEW.pilot_id AND p.id=NEW.pilot_id||':quote-v2-handset-1'
    AND p.version=1 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
    AND p.lock_id IS NULL AND p.stopped_reason IS NULL
    AND p.spent_micros=0 AND p.model_micros=0 AND p.inbound=0 AND p.outbound=0 AND p.address=0 AND p.model=0
    AND p.historical_micros=NEW.historical_micros AND p.fee_cushion_micros=NEW.fee_cushion_micros
    AND NOT EXISTS(SELECT 1 FROM whatsapp_continuation_operations o WHERE o.grant_id=p.id)
)
BEGIN SELECT RAISE(ABORT,'unused expired predecessor required'); END;
-- Once linked, freeze the zero-use predecessor so the original aggregate cap
-- cannot be bypassed by racing an old deployment or modifying its history.
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_freeze_predecessor_update
BEFORE UPDATE ON whatsapp_continuation_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_followon_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_freeze_predecessor_delete
BEFORE DELETE ON whatsapp_continuation_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_followon_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_freeze_predecessor_operation
BEFORE INSERT ON whatsapp_continuation_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_grants p JOIN whatsapp_continuation_followon_grants f ON p.pilot_id=f.pilot_id WHERE p.id=NEW.grant_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
