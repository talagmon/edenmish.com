-- Authenticated APNs device registrations for native driver route notifications.
-- Device tokens are opaque provider routing identifiers and are never written to logs.

CREATE TABLE IF NOT EXISTS driver_push_devices (
  installation_id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  device_token TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK(environment IN ('development','production')),
  app_bundle_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  disabled_at INTEGER,
  last_error TEXT,
  last_success_at INTEGER,
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);

CREATE INDEX IF NOT EXISTS idx_driver_push_devices_active
  ON driver_push_devices(driver_id, disabled_at, last_seen_at);
