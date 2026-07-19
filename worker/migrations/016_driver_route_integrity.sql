-- Add reliable driver-location samples and route-plan fingerprints.
-- Apply once after 015_driver_route_tasks.sql.

ALTER TABLE driver_routes
  ADD COLUMN plan_fingerprint TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS driver_location_samples (
  sample_id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  latitude REAL NOT NULL CHECK(latitude >= -90 AND latitude <= 90),
  longitude REAL NOT NULL CHECK(longitude >= -180 AND longitude <= 180),
  accuracy_meters REAL NOT NULL CHECK(accuracy_meters >= 0 AND accuracy_meters <= 1000),
  speed_meters_per_second REAL CHECK(speed_meters_per_second IS NULL OR speed_meters_per_second >= 0),
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (driver_id) REFERENCES drivers(id),
  FOREIGN KEY (shift_id) REFERENCES driver_shifts(id)
);

CREATE INDEX IF NOT EXISTS idx_driver_location_shift
  ON driver_location_samples(driver_id, shift_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_location_retention
  ON driver_location_samples(recorded_at);
