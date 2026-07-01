-- 003: generic rate-limit / abuse counters (idempotent).
-- Used by PR5 for OTP attempt lockout, OTP resend throttling, and per-IP order
-- creation limits. CREATE TABLE IF NOT EXISTS makes this safe on a fresh DB
-- (where schema.sql already created it) AND on existing DBs.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start INTEGER,
  last_at INTEGER,
  locked_until INTEGER
);
