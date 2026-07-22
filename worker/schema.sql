-- EdenMish delivery ops — D1 schema (SQLite)

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'received',
  name TEXT, phone TEXT, customer_type TEXT,
  pickup TEXT, pickup_detail TEXT, pickup_lat REAL, pickup_lng REAL, pickup_city TEXT,
  dropoff TEXT, dropoff_detail TEXT, dropoff_lat REAL, dropoff_lng REAL, dropoff_city TEXT,
  when_text TEXT, when_date TEXT, when_hour INTEGER,
  service TEXT, size TEXT, package TEXT, urgent INTEGER DEFAULT 0, notes TEXT,
  distance_km REAL,
  price INTEGER, currency TEXT DEFAULT 'ILS',
  review_flag INTEGER DEFAULT 0, review_reason TEXT,
  payment_url TEXT, payment_status TEXT DEFAULT 'none', payment_id TEXT,
  invoice_number TEXT, invoice_url TEXT,
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
  email TEXT, email_verified INTEGER DEFAULT 0, otp_hash TEXT, otp_expires INTEGER,
  business_account_id INTEGER,
  wallet_reservation_id TEXT,
  payment_method TEXT
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

-- Durable completion marker + retryable customer-notification outbox. The unique
-- logical job prevents event replay/concurrency from creating duplicate work.
CREATE TABLE IF NOT EXISTS delivery_completion_transitions (
  order_id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS delivery_notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  transition TEXT NOT NULL CHECK(transition = 'delivered'),
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email', 'whatsapp')),
  template TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'sent', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE(order_id, transition, channel, template),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_notification_outbox_due
  ON delivery_notification_outbox(state, next_attempt_at, lease_expires_at, id);

-- Online cancellation notices. The full identity number is deliberately not
-- persisted; only its last four digits are retained for request correlation.
CREATE TABLE IF NOT EXISTS cancellation_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  identity_last4 TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cancellation_requests_status ON cancellation_requests(status, created_at DESC);

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

-- Driver mobile API v1. The app receives scoped snapshots/events through the
-- Worker and never connects to D1 directly.
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
  onboard_order_ids_json TEXT NOT NULL DEFAULT '[]',
  plan_fingerprint TEXT NOT NULL DEFAULT '',
  UNIQUE (shift_id, revision),
  FOREIGN KEY (shift_id) REFERENCES driver_shifts(id)
);

CREATE TABLE IF NOT EXISTS driver_route_stops (
  route_id INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'dropoff' CHECK(task_type IN ('pickup','dropoff')),
  required_predecessor_stop_id TEXT,
  state TEXT NOT NULL,
  eta TEXT NOT NULL,
  promised_from TEXT NOT NULL,
  promised_to TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal',
  inserted INTEGER NOT NULL DEFAULT 0,
  service_duration_seconds INTEGER NOT NULL DEFAULT 300
    CHECK(service_duration_seconds >= 0 AND service_duration_seconds <= 7200),
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

-- Passwordless business accounts + prepaid wallets (018). Shopify owns checkout;
-- these D1 records own account identity, wallet credit, and delivery deductions.
CREATE TABLE IF NOT EXISTS business_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  phone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT,
  plan_id TEXT CHECK(plan_id IN ('silver','gold','platinum')),
  rate_plan_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_members (
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','staff')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS business_auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_auth_email ON business_auth_challenges(email, created_at DESC);

CREATE TABLE IF NOT EXISTS business_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_business_sessions_expiry ON business_sessions(expires_at);

CREATE TABLE IF NOT EXISTS business_wallets (
  account_id INTEGER PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'ILS',
  available_agorot INTEGER NOT NULL DEFAULT 0 CHECK(available_agorot >= 0),
  reserved_agorot INTEGER NOT NULL DEFAULT 0 CHECK(reserved_agorot >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_topups (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('silver','gold','platinum')),
  amount_agorot INTEGER NOT NULL CHECK(amount_agorot > 0),
  currency TEXT NOT NULL DEFAULT 'ILS',
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','checkout_ready','paid','mismatch','cancelled')),
  shopify_draft_order_id TEXT,
  shopify_order_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_account ON wallet_topups(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_credit_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  topup_id TEXT NOT NULL UNIQUE,
  original_agorot INTEGER NOT NULL CHECK(original_agorot > 0),
  remaining_agorot INTEGER NOT NULL CHECK(remaining_agorot >= 0),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_lots_fifo ON wallet_credit_lots(account_id, expires_at, id);

CREATE TABLE IF NOT EXISTS wallet_reservations (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  order_id INTEGER UNIQUE,
  idempotency_key TEXT NOT NULL,
  amount_agorot INTEGER NOT NULL CHECK(amount_agorot > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','captured','released')),
  created_at INTEGER NOT NULL,
  captured_at INTEGER,
  released_at INTEGER,
  UNIQUE(account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_wallet_reservations_account ON wallet_reservations(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('topup','reserve','capture','release','refund','expiry','adjustment')),
  available_delta_agorot INTEGER NOT NULL DEFAULT 0,
  reserved_delta_agorot INTEGER NOT NULL DEFAULT 0,
  topup_id TEXT,
  reservation_id TEXT,
  order_id INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_account ON wallet_entries(account_id, id DESC);

CREATE TABLE IF NOT EXISTS business_plan_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('silver','gold','platinum')),
  rate_plan_version TEXT NOT NULL,
  topup_id TEXT NOT NULL UNIQUE,
  starts_at INTEGER NOT NULL,
  credit_expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_business_account ON orders(business_account_id, created_at DESC);

INSERT OR IGNORE INTO pricing_rules (name, value) VALUES
  ('base_envelope','59'),
  ('base_item','69'),
  ('base_box','89'),
  ('per_km','4'),
  ('included_km','3'),
  ('urgent_pct','25'),
  ('max_km','25'),
  ('price_threshold','200');
