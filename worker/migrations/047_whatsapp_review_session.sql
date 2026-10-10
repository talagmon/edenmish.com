-- Fresh immutable text-only v6. All earlier holds and both fee cushions retained.
-- No grant is created by migration; proof and authenticated issuance are separate.
CREATE TABLE IF NOT EXISTS whatsapp_review_preflight (
 id TEXT PRIMARY KEY CHECK(id='edenmish-release-smoke-20261010-r1'),
 request_sha256 TEXT NOT NULL CHECK(request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros=56320),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','failed')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=3600000),
 finished_at INTEGER CHECK(finished_at IS NULL OR (finished_at>=created_at AND finished_at<expires_at)),
 input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 16384),
 cached_tokens INTEGER CHECK(cached_tokens>=0 AND cached_tokens<=input_tokens),
 output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 1024),
 reasoning_tokens INTEGER CHECK(reasoning_tokens>=0 AND reasoning_tokens<=output_tokens),
 CHECK(status!='matched' OR (finished_at IS NOT NULL AND input_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_preflight_insert BEFORE INSERT ON whatsapp_review_preflight
WHEN NEW.status!='pending' OR NEW.finished_at IS NOT NULL OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL OR NEW.cached_tokens IS NOT NULL OR NEW.reasoning_tokens IS NOT NULL
BEGIN SELECT RAISE(ABORT,'preflight must reserve before IO'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_preflight_update BEFORE UPDATE ON whatsapp_review_preflight
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.request_sha256!=OLD.request_sha256 OR NEW.source_sha256!=OLD.source_sha256
 OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at OR NEW.status='pending'
BEGIN SELECT RAISE(ABORT,'preflight proof immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_preflight_delete BEFORE DELETE ON whatsapp_review_preflight BEGIN SELECT RAISE(ABORT,'preflight hold retained'); END;
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_grants (
 id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
 version INTEGER NOT NULL CHECK(version=6), binding_hash TEXT NOT NULL, history_hash TEXT NOT NULL,
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
 historical_micros INTEGER NOT NULL CHECK(historical_micros=912564),
 historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=707864),
 fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=780000),
 spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros BETWEEN 0 AND 293120),
 model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 56320),
 inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 8),
 outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 8),
 address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 2),
 model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 1),
 lock_id TEXT, stopped_reason TEXT, created_at INTEGER NOT NULL,
 CHECK(historical_model_micros+model_micros<=764184),
 CHECK(historical_micros+fee_cushion_micros+spent_micros<=1986244)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_operations (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_review_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
 status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0), outcome TEXT,
 input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_review_operations_grant ON whatsapp_continuation_review_operations(grant_id,kind);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_predecessor BEFORE INSERT ON whatsapp_continuation_review_grants
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants p WHERE p.pilot_id=NEW.pilot_id AND p.version=5
 AND p.id=NEW.pilot_id||':quote-v2-handset-5' AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='model_uncertain' AND p.historical_micros=735124 AND p.historical_model_micros=595224
 AND p.fee_cushion_micros=280000 AND p.spent_micros=121120 AND p.model_micros=56320 AND p.inbound=3 AND p.outbound=3 AND p.address=0 AND p.model=1)
 OR NOT EXISTS(SELECT 1 FROM whatsapp_review_preflight p WHERE p.status='matched' AND p.finished_at<=NEW.created_at AND p.expires_at>=NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'closed predecessor and successful bounded preflight required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_grant_update BEFORE UPDATE ON whatsapp_continuation_review_grants
WHEN NEW.id!=OLD.id OR NEW.pilot_id!=OLD.pilot_id OR NEW.version!=OLD.version OR NEW.binding_hash!=OLD.binding_hash OR NEW.history_hash!=OLD.history_hash
 OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at OR NEW.created_at!=OLD.created_at
 OR NEW.historical_micros!=OLD.historical_micros OR NEW.historical_model_micros!=OLD.historical_model_micros OR NEW.fee_cushion_micros!=OLD.fee_cushion_micros
 OR NEW.spent_micros<OLD.spent_micros OR NEW.model_micros<OLD.model_micros OR NEW.inbound<OLD.inbound OR NEW.outbound<OLD.outbound
 OR NEW.address<OLD.address OR NEW.model<OLD.model OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS NULL)
BEGIN SELECT RAISE(ABORT,'review allowance immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_grant_delete BEFORE DELETE ON whatsapp_continuation_review_grants BEGIN SELECT RAISE(ABORT,'review grant retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_operation_update BEFORE UPDATE ON whatsapp_continuation_review_operations
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.kind!=OLD.kind OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'review operation immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_operation_delete BEFORE DELETE ON whatsapp_continuation_review_operations BEGIN SELECT RAISE(ABORT,'review operation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_grants_insert BEFORE INSERT ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_grants_update BEFORE UPDATE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_grants_delete BEFORE DELETE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_operations_insert BEFORE INSERT ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_operations_update BEFORE UPDATE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_operations_delete BEFORE DELETE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_grants_insert BEFORE INSERT ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_grants_update BEFORE UPDATE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_grants_delete BEFORE DELETE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_attempts_insert BEFORE INSERT ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_attempts_update BEFORE UPDATE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_attempts_delete BEFORE DELETE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
