-- Separately issued audio allowance. No grant is created by customer traffic.
CREATE TABLE IF NOT EXISTS whatsapp_voice_grants (
 id TEXT PRIMARY KEY, binding_hash TEXT NOT NULL,
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 max_calls INTEGER NOT NULL CHECK(max_calls BETWEEN 1 AND 6),
 approved_micros INTEGER NOT NULL CHECK(approved_micros BETWEEN 5000 AND 30000),
 used_calls INTEGER NOT NULL DEFAULT 0 CHECK(used_calls BETWEEN 0 AND max_calls),
 reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros BETWEEN 0 AND approved_micros),
 stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN(0,1)),
 CHECK(expires_at>starts_at AND expires_at-starts_at<=900000)
);
CREATE TABLE IF NOT EXISTS whatsapp_voice_attempts (
 event_key TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES whatsapp_voice_grants(id),
 created_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN('pending','ok','failed')),
 seconds REAL, CHECK(seconds IS NULL OR (seconds>0 AND seconds<=60))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_reserve BEFORE INSERT ON whatsapp_voice_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM whatsapp_voice_grants WHERE id=NEW.grant_id AND stopped=0
 AND starts_at<=NEW.created_at AND expires_at>NEW.created_at AND used_calls<max_calls
 AND reserved_micros+5000<=approved_micros) THEN RAISE(ABORT,'voice_budget_closed') END;
 UPDATE whatsapp_voice_grants SET used_calls=used_calls+1,reserved_micros=reserved_micros+5000 WHERE id=NEW.grant_id;
END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_immutable BEFORE UPDATE ON whatsapp_voice_grants
WHEN NEW.id!=OLD.id OR NEW.binding_hash!=OLD.binding_hash OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at
 OR NEW.max_calls!=OLD.max_calls OR NEW.approved_micros!=OLD.approved_micros OR NEW.used_calls<OLD.used_calls
 OR NEW.reserved_micros<OLD.reserved_micros OR NEW.stopped<OLD.stopped
BEGIN SELECT RAISE(ABORT,'voice_allowance_is_immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_no_delete BEFORE DELETE ON whatsapp_voice_grants BEGIN SELECT RAISE(ABORT,'voice_allowance_is_retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_attempt_no_delete BEFORE DELETE ON whatsapp_voice_attempts BEGIN SELECT RAISE(ABORT,'voice_attempt_is_retained'); END;
