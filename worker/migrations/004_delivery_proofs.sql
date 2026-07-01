-- 004: Proof of delivery (PR7). Idempotent — safe on a fresh DB (where schema.sql
-- already created it) and on existing DBs. One row per order (order_id UNIQUE).
-- Timestamps use INTEGER epoch ms to match the rest of the schema.
CREATE TABLE IF NOT EXISTS delivery_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  receiver_name TEXT,
  delivery_note TEXT,
  photo_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
