-- Per-driver, expiring login invitations for manual entry and QR pairing.
-- Raw invitation codes are returned once to authenticated Ops and never stored.

CREATE TABLE IF NOT EXISTS driver_login_invitations (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_session_id TEXT,
  consumed_installation_id TEXT,
  revoked_at INTEGER,
  FOREIGN KEY (driver_id) REFERENCES drivers(id),
  FOREIGN KEY (consumed_session_id) REFERENCES driver_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_driver_login_invitations_driver
  ON driver_login_invitations(driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_login_invitations_active
  ON driver_login_invitations(code_hash, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
