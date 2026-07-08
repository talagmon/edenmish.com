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
  rating INTEGER,                       -- customer delivery rating 1-5 (POST /api/orders/:token/rate)
  -- Coupon snapshot (008): price stays the final charged amount; these record how we got there.
  subtotal_price INTEGER,               -- price before discount (incl. surcharges)
  discount_code TEXT,                   -- normalized uppercase code applied
  discount_amount INTEGER DEFAULT 0,
  discount_title TEXT,                  -- human title snapshot from Shopify
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

-- Proof of delivery (PR7). One row per order (upserted). Timestamps follow the
-- codebase convention (INTEGER epoch ms), matching orders/payments/gps_pings.
CREATE TABLE IF NOT EXISTS delivery_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  receiver_name TEXT,
  delivery_note TEXT,
  photo_url TEXT,          -- PoD photo (client-resized base64 JPEG)
  signature TEXT,          -- PoD customer signature (base64 PNG)
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

-- Notification audit trail (PR8). One row per attempted customer/ops notification.
-- Stores WHAT was attempted and the OUTCOME — never the body/html or OTP codes.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,                 -- nullable (system/non-order notifications)
  channel TEXT NOT NULL,            -- 'email' (today) | 'whatsapp_future' | 'sms_future' | 'system'
  template TEXT,                    -- e.g. 'customer_otp', 'ops_new_order'
  recipient TEXT,                   -- email address (internal audit; never exposed publicly)
  subject TEXT,
  status TEXT NOT NULL,             -- 'pending' | 'sent' | 'failed' | 'skipped'
  provider_ref TEXT,                -- provider message id (null until sendEmail exposes one)
  error TEXT,                       -- short, sanitized error string
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, id DESC);

-- Coupons (008). Synced snapshot of Shopify discount codes. Shopify Admin is where
-- codes are created/edited; this table caches the definition the Worker validates against.
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,               -- normalized uppercase
  shopify_discount_id TEXT,            -- Shopify price rule / discount node id
  title TEXT,
  value_type TEXT CHECK(value_type IN ('percentage','fixed_amount')),
  value REAL NOT NULL,                 -- percentage (0-100) or fixed amount in ILS
  status TEXT,                         -- e.g. 'active' | 'expired' | 'disabled'
  starts_at INTEGER,                   -- epoch ms
  ends_at INTEGER,                     -- epoch ms
  usage_limit INTEGER,                 -- NULL = unlimited (from Shopify definition)
  applies_once_per_customer INTEGER DEFAULT 0,
  synced_at INTEGER,                   -- epoch ms of last Shopify sync
  raw_shopify_json TEXT                -- full Shopify payload for debugging/resync
);

-- One row per successful coupon redemption (008). Usage limits are enforced by
-- counting rows here (per code, and per code+customer_key for once-per-customer).
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  code TEXT NOT NULL,                  -- normalized uppercase
  customer_key TEXT,                   -- stable customer identifier (e.g. normalized email)
  price_before INTEGER,                -- subtotal incl. surcharges
  discount_amount INTEGER,
  price_after INTEGER,                 -- floored at 0
  created_at INTEGER,                  -- epoch ms
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(code);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_customer ON coupon_redemptions(customer_key);

INSERT OR IGNORE INTO pricing_rules (name, value) VALUES
  ('base_envelope','59'),
  ('base_item','69'),
  ('base_box','89'),
  ('per_km','4'),
  ('included_km','3'),
  ('urgent_pct','25'),
  ('max_km','25'),
  ('price_threshold','200');
