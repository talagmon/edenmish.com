-- Driver API v1 foundation. Numbers 012-013 are reserved by parallel security work.

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'he-IL',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_sessions (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  login_code_hash TEXT NOT NULL UNIQUE, -- keyed HMAC; never store the low-entropy code directly
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);
CREATE INDEX IF NOT EXISTS idx_driver_sessions_access ON driver_sessions(access_token_hash, access_expires_at);

CREATE TABLE IF NOT EXISTS driver_shifts (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','ending','ended','recovery_required')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  location_expected INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);
CREATE INDEX IF NOT EXISTS idx_driver_shifts_current ON driver_shifts(driver_id, state, started_at DESC);

CREATE TABLE IF NOT EXISTS driver_assignments (
  driver_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (driver_id, shift_id, order_id),
  FOREIGN KEY (driver_id) REFERENCES drivers(id),
  FOREIGN KEY (shift_id) REFERENCES driver_shifts(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS driver_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  current_stop_id TEXT NOT NULL,
  current_stop_locked INTEGER NOT NULL DEFAULT 1,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  current_position INTEGER NOT NULL DEFAULT 1,
  total_stops INTEGER NOT NULL,
  UNIQUE (shift_id, revision),
  FOREIGN KEY (shift_id) REFERENCES driver_shifts(id)
);

CREATE TABLE IF NOT EXISTS driver_route_stops (
  route_id INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL,
  eta TEXT NOT NULL,
  promised_from TEXT NOT NULL,
  promised_to TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal',
  inserted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route_id, stop_id),
  FOREIGN KEY (route_id) REFERENCES driver_routes(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS driver_execution_events (
  event_id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  order_id INTEGER,
  stop_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  route_revision_seen INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  conflict_type TEXT,
  server_received_at INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  FOREIGN KEY (driver_id) REFERENCES drivers(id),
  FOREIGN KEY (shift_id) REFERENCES driver_shifts(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_driver_events_shift ON driver_execution_events(shift_id, server_received_at DESC);
