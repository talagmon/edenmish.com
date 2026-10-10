-- One separately approved Sol-low fourth window after the stopped third session.
-- Historical value includes 235224 microdollars of retained offline Sol reservations.
-- Exact predecessor holds are carried forward; no reset or refund.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_sol_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=4),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=735124),
  historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=595224),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=500000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 225280),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 12),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 12),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 3),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 4),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_model_micros+model_micros<=820504),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2000000)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_sol_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_sol_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_sol_operations_grant ON whatsapp_continuation_sol_operations(grant_id,kind);

-- Issuance cannot race old work or conceal reservations. Previous stops remain.
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_stopped_predecessor
BEFORE INSERT ON whatsapp_continuation_sol_grants
WHEN NOT EXISTS (
 SELECT 1 FROM whatsapp_continuation_retry_grants p
 WHERE p.pilot_id=NEW.pilot_id AND p.id=NEW.pilot_id||':quote-v2-handset-3'
 AND p.version=3 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='model_uncertain'
 AND p.historical_micros=405100 AND p.historical_model_micros=330000 AND p.fee_cushion_micros=500000
 AND p.spent_micros=94800 AND p.model_micros=30000
 AND p.inbound=3 AND p.outbound=3 AND p.address=0 AND p.model=1
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id)=7
 AND (SELECT SUM(reserved_micros) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id)=94800
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id AND o.kind='inbound' AND o.status='settled' AND o.reserved_micros=10300)=3
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id AND o.kind='outbound' AND o.status='settled' AND o.reserved_micros=11300)=3
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id AND o.kind='model' AND o.status='uncertain' AND o.reserved_micros=30000 AND o.finished_at IS NOT NULL)=1
)
BEGIN SELECT RAISE(ABORT,'exact stopped predecessor required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_grants_update
BEFORE UPDATE ON whatsapp_continuation_retry_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_grants_delete
BEFORE DELETE ON whatsapp_continuation_retry_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_operations_update
BEFORE UPDATE ON whatsapp_continuation_retry_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_retry_grants WHERE id=OLD.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_operations_delete
BEFORE DELETE ON whatsapp_continuation_retry_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_retry_grants WHERE id=OLD.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_operations_insert
BEFORE INSERT ON whatsapp_continuation_retry_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_retry_grants WHERE id=NEW.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
