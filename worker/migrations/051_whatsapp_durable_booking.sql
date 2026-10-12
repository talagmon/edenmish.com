-- Disabled durable full-booking inbox. Queue envelopes contain IDs only.
-- Ciphertext is purged on terminal state; metadata supports duplicate suppression.
CREATE TABLE IF NOT EXISTS whatsapp_booking_jobs (
 id TEXT PRIMARY KEY CHECK(length(id)=64),
 grant_id TEXT NOT NULL REFERENCES whatsapp_full_booking_grants(id),
 conversation_id TEXT NOT NULL REFERENCES whatsapp_booking_conversations(id) ON DELETE CASCADE,
 event_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL CHECK(deadline_at>created_at AND deadline_at<=created_at+30000),
 payload_cipher TEXT CHECK(payload_cipher IS NULL OR length(payload_cipher)<=16000),
 state TEXT NOT NULL CHECK(state IN ('pending','processing','done','uncertain','expired','superseded')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease TEXT, lease_until INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 wakeups INTEGER NOT NULL DEFAULT 0 CHECK(wakeups BETWEEN 0 AND 3),
 next_wakeup_at INTEGER NOT NULL DEFAULT 0, published_at INTEGER,
 finished_at INTEGER, reason TEXT CHECK(reason IS NULL OR reason IN ('complete','superseded','expired','stopped','budget','attempt_limit','provider_uncertain','invalid_payload','backpressure','internal_failure')),
 CHECK(state IN ('pending','processing') OR payload_cipher IS NULL)
);
CREATE INDEX IF NOT EXISTS whatsapp_booking_jobs_pending ON whatsapp_booking_jobs(state,next_attempt_at,deadline_at);
CREATE INDEX IF NOT EXISTS whatsapp_booking_jobs_conversation ON whatsapp_booking_jobs(conversation_id,created_at);
CREATE TRIGGER IF NOT EXISTS whatsapp_booking_job_immutable BEFORE UPDATE ON whatsapp_booking_jobs
WHEN NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.conversation_id!=OLD.conversation_id
 OR NEW.event_at!=OLD.event_at OR NEW.created_at!=OLD.created_at OR NEW.deadline_at!=OLD.deadline_at
 OR NEW.attempts<OLD.attempts OR NEW.wakeups<OLD.wakeups
 OR (OLD.payload_cipher IS NULL AND NEW.payload_cipher IS NOT NULL)
 OR (NEW.payload_cipher IS NOT NULL AND NEW.payload_cipher IS NOT OLD.payload_cipher)
 OR (OLD.state NOT IN ('pending','processing') AND NEW.state!=OLD.state)
BEGIN SELECT RAISE(ABORT,'booking job cannot rewind'); END;
