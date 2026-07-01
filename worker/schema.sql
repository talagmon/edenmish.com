-- EdenMish delivery ops — D1 schema (SQLite)

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'received',
  name TEXT, phone TEXT, customer_type TEXT,
  pickup TEXT, pickup_detail TEXT, pickup_lat REAL, pickup_lng REAL, pickup_city TEXT,
  dropoff TEXT, dropoff_detail TEXT, dropoff_lat REAL, dropoff_lng REAL, dropoff_city TEXT,
  when_text TEXT, package TEXT, urgent INTEGER DEFAULT 0, notes TEXT,
  distance_km REAL,
  price INTEGER, currency TEXT DEFAULT 'ILS',
  review_flag INTEGER DEFAULT 0, review_reason TEXT,
  payment_url TEXT, payment_status TEXT DEFAULT 'none', payment_id TEXT,
  -- Path 1 (Shopify Draft Orders + PayPlus app) + future Mesh/J5 pre-auth:
  shopify_draft_order_id INTEGER,   -- Shopify draft order (carries our dynamic price)
  shopify_order_id INTEGER,         -- real Shopify order after checkout completes
  payment_mode TEXT DEFAULT 'immediate',  -- 'immediate' (today) | 'preauth' (future Mesh)
  authorized_amount INTEGER,        -- used only in preauth mode (max hold)
  created_at INTEGER NOT NULL,
  picked_up_at INTEGER, delivered_at INTEGER,
  email TEXT, email_verified INTEGER DEFAULT 0, otp_hash TEXT, otp_expires INTEGER
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  at INTEGER NOT NULL,
  note TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS gps_pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_gps_order ON gps_pings(order_id, at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  amount INTEGER,
  currency TEXT DEFAULT 'ILS',
  payplus_id TEXT,
  status TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  name TEXT PRIMARY KEY,
  value TEXT
);

-- Generic rate-limit / abuse counters (OTP attempts, OTP resend, order creation per IP).
-- Keyed by a composite key, e.g. 'otpv:<token>', 'otps:<token>', 'ord:<ip>', 'ordd:<ip>'.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start INTEGER,   -- epoch ms, start of the current counting window
  last_at INTEGER,        -- epoch ms, last event timestamp
  locked_until INTEGER    -- epoch ms, optional lockout expiry
);

INSERT OR IGNORE INTO pricing_rules (name, value) VALUES
  ('base_envelope','59'),
  ('base_item','69'),
  ('base_box','89'),
  ('per_km','4'),
  ('included_km','3'),
  ('urgent_pct','25'),
  ('max_km','25'),
  ('price_threshold','200');
