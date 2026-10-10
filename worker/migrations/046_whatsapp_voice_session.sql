-- Fresh $1.65 voice test; historical holds retained outside the new allowance.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_voice_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=5),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=735124),
  historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=595224),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=280000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 675840),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 24),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 24),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 4),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 12),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_model_micros+model_micros<=1271064),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2385124)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_voice_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_voice_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_voice_operations_grant ON whatsapp_continuation_voice_operations(grant_id,kind);

CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_predecessor BEFORE INSERT ON whatsapp_continuation_voice_grants
WHEN NOT EXISTS (SELECT 1 FROM whatsapp_continuation_sol_grants p WHERE p.pilot_id=NEW.pilot_id
AND p.id=NEW.pilot_id||':quote-v2-handset-4' AND p.version=4 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
AND p.lock_id IS NULL AND p.stopped_reason IS NULL AND p.historical_micros=735124 AND p.historical_model_micros=595224
AND p.fee_cushion_micros=500000 AND p.spent_micros=0 AND p.model_micros=0 AND p.inbound=0 AND p.outbound=0 AND p.address=0 AND p.model=0
AND NOT EXISTS(SELECT 1 FROM whatsapp_continuation_sol_operations o WHERE o.grant_id=p.id))
BEGIN SELECT RAISE(ABORT,'unused expired Sol predecessor required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_grants_update BEFORE UPDATE ON whatsapp_continuation_sol_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=OLD.pilot_id) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_grants_delete BEFORE DELETE ON whatsapp_continuation_sol_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=OLD.pilot_id) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_operations_insert BEFORE INSERT ON whatsapp_continuation_sol_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_sol_grants WHERE id=NEW.grant_id)) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_operations_update BEFORE UPDATE ON whatsapp_continuation_sol_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_sol_grants WHERE id=OLD.grant_id)) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_operations_delete BEFORE DELETE ON whatsapp_continuation_sol_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_sol_grants WHERE id=OLD.grant_id)) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
