-- Store pickup and drop-off evidence independently for each route task.
-- Apply once after 016_driver_route_integrity.sql.

CREATE TABLE IF NOT EXISTS driver_task_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  stop_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  task_type TEXT NOT NULL CHECK(task_type IN ('pickup','dropoff')),
  signer_name TEXT,
  note TEXT,
  photo_url TEXT,
  signature TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (shift_id, stop_id),
  FOREIGN KEY (driver_id) REFERENCES drivers(id),
  FOREIGN KEY (shift_id) REFERENCES driver_shifts(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_driver_task_proofs_order
  ON driver_task_proofs(order_id, created_at);
