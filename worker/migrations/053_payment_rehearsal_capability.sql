-- One immutable, authenticated rehearsal authority. Never populated by customer traffic.
CREATE TABLE payment_rehearsal_runs (
 id TEXT PRIMARY KEY, config_json TEXT NOT NULL, starts_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=1800000),
 created_at INTEGER NOT NULL, stopped_at INTEGER, order_token TEXT UNIQUE,
 charge_attempt_at INTEGER, email_attempts INTEGER NOT NULL DEFAULT 0 CHECK(email_attempts BETWEEN 0 AND 4)
);
CREATE TRIGGER rehearsal_run_immutable BEFORE UPDATE ON payment_rehearsal_runs
WHEN NEW.id IS NOT OLD.id OR NEW.config_json IS NOT OLD.config_json
 OR NEW.starts_at IS NOT OLD.starts_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS NOT OLD.stopped_at)
 OR (OLD.order_token IS NOT NULL AND NEW.order_token IS NOT OLD.order_token)
 OR (OLD.charge_attempt_at IS NOT NULL AND NEW.charge_attempt_at IS NOT OLD.charge_attempt_at)
 OR NEW.email_attempts<OLD.email_attempts
BEGIN SELECT RAISE(ABORT,'rehearsal run is immutable'); END;
CREATE TRIGGER rehearsal_run_keep BEFORE DELETE ON payment_rehearsal_runs
BEGIN SELECT RAISE(ABORT,'rehearsal run audit must be retained'); END;
-- Hold installation is in the SAME SQLite statement as canonical order INSERT.
-- No interval in which a committed rehearsal order is unmarked exists.
CREATE TRIGGER rehearsal_claimed_order_hold AFTER INSERT ON orders
WHEN EXISTS(SELECT 1 FROM payment_rehearsal_runs WHERE order_token=NEW.token)
BEGIN
 SELECT RAISE(ABORT,'rehearsal order ineligible') WHERE NEW.source_channel IS NOT 'whatsapp'
  OR NEW.status IS NOT 'priced' OR NEW.payment_status IS NOT 'none'
  OR EXISTS(SELECT 1 FROM payment_rehearsal_runs WHERE order_token=NEW.token
    AND (stopped_at IS NOT NULL OR NEW.created_at<starts_at OR NEW.created_at>=expires_at));
 UPDATE orders SET rehearsal_run_id=(SELECT id FROM payment_rehearsal_runs WHERE order_token=NEW.token),
  rehearsal_created_at=NEW.created_at WHERE id=NEW.id;
 INSERT INTO status_history(order_id,status,at,note) VALUES(NEW.id,NEW.status,NEW.created_at,'payment_rehearsal_registered:capability');
END;
