-- EdenMish delivery ops — D1 schema (SQLite)

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  source_channel TEXT NOT NULL DEFAULT 'website',
  rehearsal_run_id TEXT, rehearsal_created_at INTEGER, rehearsal_closed_at INTEGER,
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
  business_external_id TEXT,
  wallet_reservation_id TEXT,
  payment_method TEXT,
  -- Set when a failed delivery leaves the package with the driver, to the reported
  -- disposition ('return_to_origin' | 'hold_for_redelivery'). See migration 025.
  retained_by_driver TEXT,
  retained_at INTEGER,             -- epoch ms the package was retained; drives 24h auto-return
  pending_redelivery_json TEXT,    -- staged corrected address + fee for a redelivery. Migration 026
  phone_delivery_link_opt_in INTEGER NOT NULL DEFAULT 0,
  phone_delivery_link_opt_in_at INTEGER
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

-- Privacy-safe paid conversion bridge (migration 032). The raw random claim
-- credential exists only in the customer's current browser session.
CREATE TABLE IF NOT EXISTS analytics_conversion_claims (
  claim_hash TEXT PRIMARY KEY
    CHECK(length(claim_hash) = 64 AND claim_hash NOT GLOB '*[^0-9a-f]*'),
  order_id INTEGER NOT NULL UNIQUE,
  disposition TEXT
    CHECK(disposition IS NULL OR disposition IN ('emitted', 'suppressed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  observed_at INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_analytics_conversion_claim_expiry
  ON analytics_conversion_claims(expires_at, observed_at);

-- A second, purpose-specific Shopify Draft Order for a corrected-address
-- redelivery. The original order payment remains immutable; this row owns the
-- retry fee and its reconciliation lifecycle.
CREATE TABLE IF NOT EXISTS redelivery_charges (
  id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE,
  amount_agorot INTEGER NOT NULL CHECK(amount_agorot > 0),
  currency TEXT NOT NULL DEFAULT 'ILS',
  address_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'creating', 'link_sent', 'paid', 'released', 'expired', 'mismatch', 'late_paid'
  )),
  payment_url TEXT,
  processor_ref TEXT,
  shopify_draft_order_id TEXT,
  shopify_order_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  released_at INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_redelivery_charges_status
  ON redelivery_charges(status, expires_at, order_id);

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
  provider_status TEXT,             -- sanitized provider lifecycle status only
  provider_updated_at INTEGER,
  error TEXT,                       -- short, sanitized error string
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_provider_ref
  ON notifications(provider_ref) WHERE provider_ref IS NOT NULL;

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
  transition TEXT NOT NULL CHECK(transition IN (
    'delivered','delivery_failed_retained','payment_received'
  )),
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
  provider_ref TEXT,
  provider_status TEXT,
  provider_updated_at INTEGER,
  UNIQUE(order_id, transition, channel, template),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_notification_outbox_due
  ON delivery_notification_outbox(state, next_attempt_at, lease_expires_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_notification_outbox_provider_ref
  ON delivery_notification_outbox(provider_ref) WHERE provider_ref IS NOT NULL;

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
  scope TEXT NOT NULL DEFAULT 'delivery' CHECK(scope IN ('delivery','business_plan')),
  business_plan_ids TEXT,              -- JSON array; NULL/[] = every business plan
  auto_apply INTEGER NOT NULL DEFAULT 0 CHECK(auto_apply IN (0,1)),
  eligibility_rule TEXT CHECK(eligibility_rule IS NULL OR eligibility_rule='first_delivery'),
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
  promotion_claim_id INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(code);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_customer ON coupon_redemptions(customer_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_promotion_claim
  ON coupon_redemptions(promotion_claim_id)
  WHERE promotion_claim_id IS NOT NULL;

-- Atomic eligibility reservation for automatic first-delivery promotions (031).
CREATE TABLE IF NOT EXISTS first_delivery_promotion_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_code TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  phone_key TEXT,
  email_key TEXT,
  business_account_id INTEGER,
  idempotency_key TEXT,
  order_id INTEGER UNIQUE,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','redeemed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (business_account_id) REFERENCES business_accounts(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_first_delivery_claim_phone
  ON first_delivery_promotion_claims(phone_key) WHERE phone_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_first_delivery_claim_email
  ON first_delivery_promotion_claims(email_key) WHERE email_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_first_delivery_claim_business
  ON first_delivery_promotion_claims(business_account_id) WHERE business_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_first_delivery_claim_business_idempotency
  ON first_delivery_promotion_claims(business_account_id, idempotency_key)
  WHERE business_account_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_paid_phone ON orders(phone, payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_paid_email ON orders(email COLLATE NOCASE, payment_status);
INSERT OR IGNORE INTO coupons (
  code, title, value_type, value, status, starts_at, ends_at, usage_limit,
  applies_once_per_customer, scope, business_plan_ids, auto_apply,
  eligibility_rule, synced_at
) VALUES (
  'FIRST10-2026', '10% הנחה למשלוח ראשון', 'percentage', 10, 'active',
  NULL, 1788209999999, NULL, 1, 'delivery', NULL, 1,
  'first_delivery', CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

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
  plan_id TEXT CHECK(plan_id IN ('trial','wallet','silver','gold','platinum')),
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

CREATE TABLE IF NOT EXISTS business_batch_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  header_signature TEXT NOT NULL CHECK(length(header_signature) = 64),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
  UNIQUE(account_id, header_signature),
  FOREIGN KEY (account_id) REFERENCES business_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_business_batch_mappings_account
  ON business_batch_mappings(account_id, updated_at DESC);

-- Account-scoped, one-use service/zone exceptions for an exact batch external ID.
CREATE TABLE IF NOT EXISTS business_delivery_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 80),
  zone INTEGER NOT NULL CHECK(zone IN (1, 2, 3)),
  service TEXT NOT NULL CHECK(service IN ('eco', 'standard', 'flash')),
  price_agorot INTEGER NOT NULL CHECK(price_agorot > 0),
  expires_at INTEGER NOT NULL,
  consumed_key TEXT CHECK(consumed_key IS NULL OR length(consumed_key) BETWEEN 1 AND 120),
  consumed_at INTEGER,
  order_id INTEGER,
  note TEXT CHECK(note IS NULL OR length(note) <= 240),
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, external_id),
  CHECK(
    (consumed_key IS NULL AND consumed_at IS NULL)
    OR (consumed_key IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  FOREIGN KEY (account_id) REFERENCES business_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_business_delivery_exceptions_lookup
  ON business_delivery_exceptions(account_id, external_id, zone, service, expires_at);

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
  plan_id TEXT NOT NULL CHECK(plan_id IN ('trial','wallet','silver','gold','platinum')),
  amount_agorot INTEGER NOT NULL CHECK(amount_agorot > 0),
  payment_amount_agorot INTEGER CHECK(payment_amount_agorot >= 0),
  discount_code TEXT,
  discount_amount_agorot INTEGER NOT NULL DEFAULT 0 CHECK(discount_amount_agorot >= 0),
  discount_title TEXT,
  currency TEXT NOT NULL DEFAULT 'ILS',
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','checkout_ready','paid','mismatch','cancelled')),
  shopify_draft_order_id TEXT,
  shopify_order_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_account ON wallet_topups(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_trial_once
  ON wallet_topups(account_id)
  WHERE plan_id = 'trial' AND status IN ('created','checkout_ready','paid');

-- Business-plan coupon reservations use wallet top-ups rather than delivery orders.
CREATE TABLE IF NOT EXISTS business_coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topup_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  customer_key TEXT,
  price_before INTEGER,
  discount_amount INTEGER,
  price_after INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (topup_id) REFERENCES wallet_topups(id)
);
CREATE INDEX IF NOT EXISTS idx_business_coupon_redemptions_code ON business_coupon_redemptions(code);
CREATE INDEX IF NOT EXISTS idx_business_coupon_redemptions_customer ON business_coupon_redemptions(customer_key);

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
  plan_id TEXT NOT NULL CHECK(plan_id IN ('trial','wallet','silver','gold','platinum')),
  rate_plan_version TEXT NOT NULL,
  topup_id TEXT NOT NULL UNIQUE,
  starts_at INTEGER NOT NULL,
  credit_expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_business_account ON orders(business_account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_business_external_id
  ON orders(business_account_id, business_external_id)
  WHERE business_account_id IS NOT NULL AND business_external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_wallet_reservation_unique
  ON orders(wallet_reservation_id)
  WHERE wallet_reservation_id IS NOT NULL;

INSERT OR IGNORE INTO pricing_rules (name, value) VALUES
  ('base_envelope','59'),
  ('base_item','69'),
  ('base_box','89'),
  ('per_km','4'),
  ('included_km','3'),
  ('urgent_pct','25'),
  ('max_km','25'),
  ('price_threshold','200');
-- Disabled incoming booking adapter. No raw inbound message bodies retained.
CREATE TABLE IF NOT EXISTS whatsapp_booking_conversations (
  id TEXT PRIMARY KEY,
  sender_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  recipient TEXT,
  state_json TEXT NOT NULL,
  phase TEXT NOT NULL,
  order_token TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id),
  last_event_at INTEGER NOT NULL DEFAULT 0,
  last_customer_at INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER,
  confirmed_at INTEGER,
  confirmed_revision INTEGER,
  confirmed_price INTEGER,
  checkout_started_at INTEGER,
  lock_id TEXT,
  lock_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_booking_events (
  event_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_booking_replies (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES whatsapp_booking_conversations(id),
  body TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  kind TEXT NOT NULL DEFAULT 'prompt',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS whatsapp_booking_replies_pending ON whatsapp_booking_replies(state, created_at);
CREATE INDEX IF NOT EXISTS whatsapp_booking_events_expiry ON whatsapp_booking_events(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_booking_reply_provider ON whatsapp_booking_replies(provider_ref) WHERE provider_ref IS NOT NULL;

-- Sanitized signed delivery receipts survive callback-before-send-response races.
CREATE TABLE IF NOT EXISTS whatsapp_booking_receipts (
  provider_ref TEXT PRIMARY KEY,
  rank INTEGER NOT NULL,
  applied_rank INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Bounded staging pilot only. No message bodies, addresses, phone numbers or keys.
CREATE TABLE IF NOT EXISTS whatsapp_pilot_budgets (
  pilot_id TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  started_at INTEGER,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
  charged_micros INTEGER NOT NULL DEFAULT 0 CHECK(charged_micros BETWEEN 0 AND 500000),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_pilot_model_attempts (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL REFERENCES whatsapp_pilot_budgets(pilot_id),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  charged_micros INTEGER NOT NULL CHECK(charged_micros BETWEEN 0 AND 300000),
  input_tokens INTEGER,
  output_tokens INTEGER,
  outcome TEXT,
  readiness_case TEXT,
  http_status INTEGER,
  elapsed_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS whatsapp_pilot_model_attempts_pilot ON whatsapp_pilot_model_attempts(pilot_id, created_at);
-- Explicit versioned continuation; never rewrites the original stopped ledger.
-- One grant per original run, no chat/phone/key data, no retention cleanup.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=1),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=1800000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=300000),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=500000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 180000),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 10),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 10),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 3),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 6),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_micros+model_micros<=500000),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2000000)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_operations_grant ON whatsapp_continuation_operations(grant_id,kind);
-- One explicitly approved second window, only after an unused expired v1 grant.
-- Original tables are untouched; original historical holds/cushion apply once.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_followon_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=2),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=1800000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=300000),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=500000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 180000),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 10),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 10),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 3),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 6),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_micros+model_micros<=500000),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2000000)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_followon_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_followon_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_followon_operations_grant ON whatsapp_continuation_followon_operations(grant_id,kind);

-- Reject issuance races or an attempt to carry unrecorded predecessor spend.
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_unused_predecessor
BEFORE INSERT ON whatsapp_continuation_followon_grants
WHEN NOT EXISTS (
  SELECT 1 FROM whatsapp_continuation_grants p
  WHERE p.pilot_id=NEW.pilot_id AND p.id=NEW.pilot_id||':quote-v2-handset-1'
    AND p.version=1 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
    AND p.lock_id IS NULL AND p.stopped_reason IS NULL
    AND p.spent_micros=0 AND p.model_micros=0 AND p.inbound=0 AND p.outbound=0 AND p.address=0 AND p.model=0
    AND p.historical_micros=NEW.historical_micros AND p.fee_cushion_micros=NEW.fee_cushion_micros
    AND NOT EXISTS(SELECT 1 FROM whatsapp_continuation_operations o WHERE o.grant_id=p.id)
)
BEGIN SELECT RAISE(ABORT,'unused expired predecessor required'); END;
-- Once linked, freeze the zero-use predecessor so the original aggregate cap
-- cannot be bypassed by racing an old deployment or modifying its history.
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_freeze_predecessor_update
BEFORE UPDATE ON whatsapp_continuation_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_followon_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_freeze_predecessor_delete
BEFORE DELETE ON whatsapp_continuation_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_followon_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_followon_freeze_predecessor_operation
BEFORE INSERT ON whatsapp_continuation_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_grants p JOIN whatsapp_continuation_followon_grants f ON p.pilot_id=f.pilot_id WHERE p.id=NEW.grant_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;

-- One separately approved third window after the stopped October 9 rehearsal.
-- Exact predecessor holds are carried forward; no reset or refund.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_retry_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=3),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=1800000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=405100),
  historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=330000),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=500000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 150000),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 10),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 10),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 3),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 5),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_model_micros+model_micros<=500000),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2000000)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_retry_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_retry_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_retry_operations_grant ON whatsapp_continuation_retry_operations(grant_id,kind);

-- Issuance cannot race old work or conceal reservations. Previous stops remain.
CREATE TRIGGER IF NOT EXISTS whatsapp_retry_stopped_predecessor
BEFORE INSERT ON whatsapp_continuation_retry_grants
WHEN NOT EXISTS (
 SELECT 1 FROM whatsapp_continuation_followon_grants p
 WHERE p.pilot_id=NEW.pilot_id AND p.id=NEW.pilot_id||':quote-v2-handset-2'
 AND p.version=2 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='provider_uncertain'
 AND p.historical_micros=300000 AND p.fee_cushion_micros=500000
 AND p.spent_micros=105100 AND p.model_micros=30000
 AND p.inbound=4 AND p.outbound=3 AND p.address=0 AND p.model=1
 AND (SELECT COUNT(*) FROM whatsapp_continuation_followon_operations o WHERE o.grant_id=p.id)=8
 AND (SELECT SUM(reserved_micros) FROM whatsapp_continuation_followon_operations o WHERE o.grant_id=p.id)=105100
 AND (SELECT COUNT(*) FROM whatsapp_continuation_followon_operations o WHERE o.grant_id=p.id AND o.kind='inbound' AND o.status='settled' AND o.reserved_micros=10300)=4
 AND (SELECT COUNT(*) FROM whatsapp_continuation_followon_operations o WHERE o.grant_id=p.id AND o.kind='outbound' AND o.status='settled' AND o.reserved_micros=11300)=3
 AND (SELECT COUNT(*) FROM whatsapp_continuation_followon_operations o WHERE o.grant_id=p.id AND o.kind='model' AND o.status='uncertain' AND o.reserved_micros=30000 AND o.finished_at IS NOT NULL)=1
)
BEGIN SELECT RAISE(ABORT,'exact stopped predecessor required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_retry_freeze_grants_update
BEFORE UPDATE ON whatsapp_continuation_followon_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_retry_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_retry_freeze_grants_delete
BEFORE DELETE ON whatsapp_continuation_followon_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_retry_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_retry_freeze_operations_update
BEFORE UPDATE ON whatsapp_continuation_followon_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_retry_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_followon_grants WHERE id=OLD.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_retry_freeze_operations_delete
BEFORE DELETE ON whatsapp_continuation_followon_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_retry_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_followon_grants WHERE id=OLD.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_retry_freeze_operations_insert
BEFORE INSERT ON whatsapp_continuation_followon_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_retry_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_followon_grants WHERE id=NEW.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;

-- One separately approved Sol-low fourth window after the stopped third session.
-- Historical value includes 235224 microdollars of retained offline Sol reservations.
-- Exact predecessor holds are carried forward; no reset or refund.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_sol_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=4),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=735124),
  historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=595224),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=500000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 225280),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 12),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 12),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 3),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 4),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_model_micros+model_micros<=820504),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2000000)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_sol_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_sol_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_sol_operations_grant ON whatsapp_continuation_sol_operations(grant_id,kind);

-- Issuance cannot race old work or conceal reservations. Previous stops remain.
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_stopped_predecessor
BEFORE INSERT ON whatsapp_continuation_sol_grants
WHEN NOT EXISTS (
 SELECT 1 FROM whatsapp_continuation_retry_grants p
 WHERE p.pilot_id=NEW.pilot_id AND p.id=NEW.pilot_id||':quote-v2-handset-3'
 AND p.version=3 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='model_uncertain'
 AND p.historical_micros=405100 AND p.historical_model_micros=330000 AND p.fee_cushion_micros=500000
 AND p.spent_micros=94800 AND p.model_micros=30000
 AND p.inbound=3 AND p.outbound=3 AND p.address=0 AND p.model=1
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id)=7
 AND (SELECT SUM(reserved_micros) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id)=94800
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id AND o.kind='inbound' AND o.status='settled' AND o.reserved_micros=10300)=3
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id AND o.kind='outbound' AND o.status='settled' AND o.reserved_micros=11300)=3
 AND (SELECT COUNT(*) FROM whatsapp_continuation_retry_operations o WHERE o.grant_id=p.id AND o.kind='model' AND o.status='uncertain' AND o.reserved_micros=30000 AND o.finished_at IS NOT NULL)=1
)
BEGIN SELECT RAISE(ABORT,'exact stopped predecessor required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_grants_update
BEFORE UPDATE ON whatsapp_continuation_retry_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_grants_delete
BEFORE DELETE ON whatsapp_continuation_retry_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=OLD.pilot_id)
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_operations_update
BEFORE UPDATE ON whatsapp_continuation_retry_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_retry_grants WHERE id=OLD.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_operations_delete
BEFORE DELETE ON whatsapp_continuation_retry_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_retry_grants WHERE id=OLD.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_sol_freeze_operations_insert
BEFORE INSERT ON whatsapp_continuation_retry_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_sol_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_retry_grants WHERE id=NEW.grant_id))
BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;

-- Separately issued audio allowance. No grant is created by customer traffic.
CREATE TABLE IF NOT EXISTS whatsapp_voice_grants (
 id TEXT PRIMARY KEY, binding_hash TEXT NOT NULL,
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 max_calls INTEGER NOT NULL CHECK(max_calls BETWEEN 1 AND 6),
 approved_micros INTEGER NOT NULL CHECK(approved_micros BETWEEN 5000 AND 30000),
 used_calls INTEGER NOT NULL DEFAULT 0 CHECK(used_calls BETWEEN 0 AND max_calls),
 reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros BETWEEN 0 AND approved_micros),
 stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN(0,1)),
 CHECK(expires_at>starts_at AND expires_at-starts_at<=900000)
);
CREATE TABLE IF NOT EXISTS whatsapp_voice_attempts (
 event_key TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES whatsapp_voice_grants(id),
 created_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN('pending','ok','failed')),
 seconds REAL, CHECK(seconds IS NULL OR (seconds>0 AND seconds<=60))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_reserve BEFORE INSERT ON whatsapp_voice_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM whatsapp_voice_grants WHERE id=NEW.grant_id AND stopped=0
 AND starts_at<=NEW.created_at AND expires_at>NEW.created_at AND used_calls<max_calls
 AND reserved_micros+5000<=approved_micros) THEN RAISE(ABORT,'voice_budget_closed') END;
 UPDATE whatsapp_voice_grants SET used_calls=used_calls+1,reserved_micros=reserved_micros+5000 WHERE id=NEW.grant_id;
END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_immutable BEFORE UPDATE ON whatsapp_voice_grants
WHEN NEW.id!=OLD.id OR NEW.binding_hash!=OLD.binding_hash OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at
 OR NEW.max_calls!=OLD.max_calls OR NEW.approved_micros!=OLD.approved_micros OR NEW.used_calls<OLD.used_calls
 OR NEW.reserved_micros<OLD.reserved_micros OR NEW.stopped<OLD.stopped
BEGIN SELECT RAISE(ABORT,'voice_allowance_is_immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_no_delete BEFORE DELETE ON whatsapp_voice_grants BEGIN SELECT RAISE(ABORT,'voice_allowance_is_retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_attempt_no_delete BEFORE DELETE ON whatsapp_voice_attempts BEGIN SELECT RAISE(ABORT,'voice_attempt_is_retained'); END;

-- Fresh $1.65 voice test; historical holds retained outside the new allowance.
CREATE TABLE IF NOT EXISTS whatsapp_continuation_voice_grants (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
  version INTEGER NOT NULL CHECK(version=5),
  binding_hash TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
  historical_micros INTEGER NOT NULL CHECK(historical_micros=735124),
  historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=595224),
  fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=280000),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 675840),
  inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 24),
  outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 24),
  address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 4),
  model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 12),
  lock_id TEXT,
  stopped_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK(historical_model_micros+model_micros<=1271064),
  CHECK(historical_micros+fee_cushion_micros+spent_micros<=2385124)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_voice_operations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_voice_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
  status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_voice_operations_grant ON whatsapp_continuation_voice_operations(grant_id,kind);

CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_predecessor BEFORE INSERT ON whatsapp_continuation_voice_grants
WHEN NOT EXISTS (SELECT 1 FROM whatsapp_continuation_sol_grants p WHERE p.pilot_id=NEW.pilot_id
AND p.id=NEW.pilot_id||':quote-v2-handset-4' AND p.version=4 AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
AND p.lock_id IS NULL AND p.stopped_reason IS NULL AND p.historical_micros=735124 AND p.historical_model_micros=595224
AND p.fee_cushion_micros=500000 AND p.spent_micros=0 AND p.model_micros=0 AND p.inbound=0 AND p.outbound=0 AND p.address=0 AND p.model=0
AND NOT EXISTS(SELECT 1 FROM whatsapp_continuation_sol_operations o WHERE o.grant_id=p.id))
BEGIN SELECT RAISE(ABORT,'unused expired Sol predecessor required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_grants_update BEFORE UPDATE ON whatsapp_continuation_sol_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=OLD.pilot_id) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_grants_delete BEFORE DELETE ON whatsapp_continuation_sol_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=OLD.pilot_id) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_operations_insert BEFORE INSERT ON whatsapp_continuation_sol_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_sol_grants WHERE id=NEW.grant_id)) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_operations_update BEFORE UPDATE ON whatsapp_continuation_sol_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_sol_grants WHERE id=OLD.grant_id)) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_voice_session_freeze_operations_delete BEFORE DELETE ON whatsapp_continuation_sol_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants WHERE pilot_id=(SELECT pilot_id FROM whatsapp_continuation_sol_grants WHERE id=OLD.grant_id)) BEGIN SELECT RAISE(ABORT,'predecessor retained'); END;

-- Fresh immutable text-only v6. All earlier holds and both fee cushions retained.
-- No grant is created by migration; proof and authenticated issuance are separate.
CREATE TABLE IF NOT EXISTS whatsapp_review_preflight (
 id TEXT PRIMARY KEY CHECK(id='edenmish-release-smoke-20261010-r1'),
 request_sha256 TEXT NOT NULL CHECK(request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros=56320),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','failed')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=3600000),
 finished_at INTEGER CHECK(finished_at IS NULL OR (finished_at>=created_at AND finished_at<expires_at)),
 input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 16384),
 cached_tokens INTEGER CHECK(cached_tokens>=0 AND cached_tokens<=input_tokens),
 output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 1024),
 reasoning_tokens INTEGER CHECK(reasoning_tokens>=0 AND reasoning_tokens<=output_tokens),
 CHECK(status!='matched' OR (finished_at IS NOT NULL AND input_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_preflight_insert BEFORE INSERT ON whatsapp_review_preflight
WHEN NEW.status!='pending' OR NEW.finished_at IS NOT NULL OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL OR NEW.cached_tokens IS NOT NULL OR NEW.reasoning_tokens IS NOT NULL
BEGIN SELECT RAISE(ABORT,'preflight must reserve before IO'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_preflight_update BEFORE UPDATE ON whatsapp_review_preflight
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.request_sha256!=OLD.request_sha256 OR NEW.source_sha256!=OLD.source_sha256
 OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at OR NEW.status='pending'
BEGIN SELECT RAISE(ABORT,'preflight proof immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_preflight_delete BEFORE DELETE ON whatsapp_review_preflight BEGIN SELECT RAISE(ABORT,'preflight hold retained'); END;
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_grants (
 id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
 version INTEGER NOT NULL CHECK(version=6), binding_hash TEXT NOT NULL, history_hash TEXT NOT NULL,
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
 historical_micros INTEGER NOT NULL CHECK(historical_micros=912564),
 historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=707864),
 fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=780000),
 spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros BETWEEN 0 AND 293120),
 model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 56320),
 inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 8),
 outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 8),
 address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 2),
 model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 1),
 lock_id TEXT, stopped_reason TEXT, created_at INTEGER NOT NULL,
 CHECK(historical_model_micros+model_micros<=764184),
 CHECK(historical_micros+fee_cushion_micros+spent_micros<=1986244)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_operations (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_review_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
 status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0), outcome TEXT,
 input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_review_operations_grant ON whatsapp_continuation_review_operations(grant_id,kind);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_predecessor BEFORE INSERT ON whatsapp_continuation_review_grants
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants p WHERE p.pilot_id=NEW.pilot_id AND p.version=5
 AND p.id=NEW.pilot_id||':quote-v2-handset-5' AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='model_uncertain' AND p.historical_micros=735124 AND p.historical_model_micros=595224
 AND p.fee_cushion_micros=280000 AND p.spent_micros=121120 AND p.model_micros=56320 AND p.inbound=3 AND p.outbound=3 AND p.address=0 AND p.model=1)
 OR NOT EXISTS(SELECT 1 FROM whatsapp_review_preflight p WHERE p.status='matched' AND p.finished_at<=NEW.created_at AND p.expires_at>=NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'closed predecessor and successful bounded preflight required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_grant_update BEFORE UPDATE ON whatsapp_continuation_review_grants
WHEN NEW.id!=OLD.id OR NEW.pilot_id!=OLD.pilot_id OR NEW.version!=OLD.version OR NEW.binding_hash!=OLD.binding_hash OR NEW.history_hash!=OLD.history_hash
 OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at OR NEW.created_at!=OLD.created_at
 OR NEW.historical_micros!=OLD.historical_micros OR NEW.historical_model_micros!=OLD.historical_model_micros OR NEW.fee_cushion_micros!=OLD.fee_cushion_micros
 OR NEW.spent_micros<OLD.spent_micros OR NEW.model_micros<OLD.model_micros OR NEW.inbound<OLD.inbound OR NEW.outbound<OLD.outbound
 OR NEW.address<OLD.address OR NEW.model<OLD.model OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS NULL)
BEGIN SELECT RAISE(ABORT,'review allowance immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_grant_delete BEFORE DELETE ON whatsapp_continuation_review_grants BEGIN SELECT RAISE(ABORT,'review grant retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_operation_update BEFORE UPDATE ON whatsapp_continuation_review_operations
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.kind!=OLD.kind OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'review operation immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_operation_delete BEFORE DELETE ON whatsapp_continuation_review_operations BEGIN SELECT RAISE(ABORT,'review operation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_grants_insert BEFORE INSERT ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_grants_update BEFORE UPDATE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_grants_delete BEFORE DELETE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_operations_insert BEFORE INSERT ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_operations_update BEFORE UPDATE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_continuation_voice_operations_delete BEFORE DELETE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_grants_insert BEFORE INSERT ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_grants_update BEFORE UPDATE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_grants_delete BEFORE DELETE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_attempts_insert BEFORE INSERT ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_attempts_update BEFORE UPDATE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_freeze_whatsapp_voice_attempts_delete BEFORE DELETE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;

-- Fresh immutable text-only v7; r1 failure is retained. All earlier holds and both fee cushions retained.
-- No grant is created by migration; proof and authenticated issuance are separate.
CREATE TABLE IF NOT EXISTS whatsapp_review_r2_preflight (
 id TEXT PRIMARY KEY CHECK(id='edenmish-release-smoke-20261011-r2'),
 request_sha256 TEXT NOT NULL CHECK(request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros=56320),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','failed')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=3600000),
 finished_at INTEGER CHECK(finished_at IS NULL OR (finished_at>=created_at AND finished_at<expires_at)),
 input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 16384),
 cached_tokens INTEGER CHECK(cached_tokens>=0 AND cached_tokens<=input_tokens),
 output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 1024),
 reasoning_tokens INTEGER CHECK(reasoning_tokens>=0 AND reasoning_tokens<=output_tokens),
 CHECK(status!='matched' OR (finished_at IS NOT NULL AND input_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_preflight_insert BEFORE INSERT ON whatsapp_review_r2_preflight
WHEN NEW.status!='pending' OR NEW.finished_at IS NOT NULL OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL OR NEW.cached_tokens IS NOT NULL OR NEW.reasoning_tokens IS NOT NULL
BEGIN SELECT RAISE(ABORT,'preflight must reserve before IO'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_preflight_update BEFORE UPDATE ON whatsapp_review_r2_preflight
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.request_sha256!=OLD.request_sha256 OR NEW.source_sha256!=OLD.source_sha256
 OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at OR NEW.status='pending'
BEGIN SELECT RAISE(ABORT,'preflight proof immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_preflight_delete BEFORE DELETE ON whatsapp_review_r2_preflight BEGIN SELECT RAISE(ABORT,'preflight hold retained'); END;
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_r2_grants (
 id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
 version INTEGER NOT NULL CHECK(version=7), binding_hash TEXT NOT NULL, history_hash TEXT NOT NULL,
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
 historical_micros INTEGER NOT NULL CHECK(historical_micros=968884),
 historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=764184),
 fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=780000),
 spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros BETWEEN 0 AND 249920),
 model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 56320),
 inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 6),
 outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 6),
 address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 2),
 model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 1),
 lock_id TEXT, stopped_reason TEXT, created_at INTEGER NOT NULL,
 CHECK(historical_model_micros+model_micros<=820504),
 CHECK(historical_micros+fee_cushion_micros+spent_micros<=1998804)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_r2_operations (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_review_r2_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
 status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0), outcome TEXT,
 input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_review_r2_operations_grant ON whatsapp_continuation_review_r2_operations(grant_id,kind);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_predecessor BEFORE INSERT ON whatsapp_continuation_review_r2_grants
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants p WHERE p.pilot_id=NEW.pilot_id AND p.version=5
 AND p.id=NEW.pilot_id||':quote-v2-handset-5' AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='model_uncertain' AND p.historical_micros=735124 AND p.historical_model_micros=595224
 AND p.fee_cushion_micros=280000 AND p.spent_micros=121120 AND p.model_micros=56320 AND p.inbound=3 AND p.outbound=3 AND p.address=0 AND p.model=1)
 OR NOT EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight p WHERE p.status='matched' AND p.finished_at<=NEW.created_at AND p.expires_at>=NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'closed predecessor and successful bounded preflight required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_grant_update BEFORE UPDATE ON whatsapp_continuation_review_r2_grants
WHEN NEW.id!=OLD.id OR NEW.pilot_id!=OLD.pilot_id OR NEW.version!=OLD.version OR NEW.binding_hash!=OLD.binding_hash OR NEW.history_hash!=OLD.history_hash
 OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at OR NEW.created_at!=OLD.created_at
 OR NEW.historical_micros!=OLD.historical_micros OR NEW.historical_model_micros!=OLD.historical_model_micros OR NEW.fee_cushion_micros!=OLD.fee_cushion_micros
 OR NEW.spent_micros<OLD.spent_micros OR NEW.model_micros<OLD.model_micros OR NEW.inbound<OLD.inbound OR NEW.outbound<OLD.outbound
 OR NEW.address<OLD.address OR NEW.model<OLD.model OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS NULL)
BEGIN SELECT RAISE(ABORT,'review allowance immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_grant_delete BEFORE DELETE ON whatsapp_continuation_review_r2_grants BEGIN SELECT RAISE(ABORT,'review grant retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_operation_update BEFORE UPDATE ON whatsapp_continuation_review_r2_operations
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.kind!=OLD.kind OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'review operation immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r2_operation_delete BEFORE DELETE ON whatsapp_continuation_review_r2_operations BEGIN SELECT RAISE(ABORT,'review operation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_voice_grants_insert BEFORE INSERT ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_voice_grants_update BEFORE UPDATE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_voice_grants_delete BEFORE DELETE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_voice_operations_insert BEFORE INSERT ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_voice_operations_update BEFORE UPDATE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_voice_operations_delete BEFORE DELETE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_voice_grants_insert BEFORE INSERT ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_voice_grants_update BEFORE UPDATE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_voice_grants_delete BEFORE DELETE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_voice_attempts_insert BEFORE INSERT ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_voice_attempts_update BEFORE UPDATE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_voice_attempts_delete BEFORE DELETE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;

CREATE TRIGGER IF NOT EXISTS review_r2_reservation_predecessor BEFORE INSERT ON whatsapp_review_r2_preflight
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_review_preflight p WHERE p.id='edenmish-release-smoke-20261010-r1'
 AND p.status='failed' AND p.reserved_micros=56320
 AND p.request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'
 AND p.source_sha256='9463b47cce9e4ff77e49cb3640f6ae67789187f4d1a30630d14862b7a9de835f'
 AND p.finished_at IS NOT NULL AND p.finished_at>=p.created_at AND p.finished_at<=NEW.created_at)
 OR EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants)
 OR EXISTS(SELECT 1 FROM whatsapp_continuation_review_operations)
BEGIN SELECT RAISE(ABORT,'failed r1 hold and unused v6 allocation required'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_review_preflight_insert BEFORE INSERT ON whatsapp_review_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_review_preflight_update BEFORE UPDATE ON whatsapp_review_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_review_preflight_delete BEFORE DELETE ON whatsapp_review_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_review_grants_insert BEFORE INSERT ON whatsapp_continuation_review_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_review_grants_update BEFORE UPDATE ON whatsapp_continuation_review_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_review_grants_delete BEFORE DELETE ON whatsapp_continuation_review_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_review_operations_insert BEFORE INSERT ON whatsapp_continuation_review_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_review_operations_update BEFORE UPDATE ON whatsapp_continuation_review_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r2_freeze_whatsapp_continuation_review_operations_delete BEFORE DELETE ON whatsapp_continuation_review_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;

-- Fresh immutable text-only v8; both r1 and r2 failures are retained. All earlier holds and both fee cushions retained.
-- No grant is created by migration; proof and authenticated issuance are separate.
CREATE TABLE IF NOT EXISTS whatsapp_review_r3_preflight (
 id TEXT PRIMARY KEY CHECK(id='edenmish-release-smoke-20261011-r3'),
 request_sha256 TEXT NOT NULL CHECK(request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros=56320),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','failed')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=3600000),
 finished_at INTEGER CHECK(finished_at IS NULL OR (finished_at>=created_at AND finished_at<expires_at)),
 input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 16384),
 cached_tokens INTEGER CHECK(cached_tokens>=0 AND cached_tokens<=input_tokens),
 output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 1024),
 reasoning_tokens INTEGER CHECK(reasoning_tokens>=0 AND reasoning_tokens<=output_tokens),
 CHECK(status!='matched' OR (finished_at IS NOT NULL AND input_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_preflight_insert BEFORE INSERT ON whatsapp_review_r3_preflight
WHEN NEW.status!='pending' OR NEW.finished_at IS NOT NULL OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL OR NEW.cached_tokens IS NOT NULL OR NEW.reasoning_tokens IS NOT NULL
BEGIN SELECT RAISE(ABORT,'preflight must reserve before IO'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_preflight_update BEFORE UPDATE ON whatsapp_review_r3_preflight
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.request_sha256!=OLD.request_sha256 OR NEW.source_sha256!=OLD.source_sha256
 OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at OR NEW.status='pending'
BEGIN SELECT RAISE(ABORT,'preflight proof immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_preflight_delete BEFORE DELETE ON whatsapp_review_r3_preflight BEGIN SELECT RAISE(ABORT,'preflight hold retained'); END;
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_r3_grants (
 id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_pilot_budgets(pilot_id),
 version INTEGER NOT NULL CHECK(version=8), binding_hash TEXT NOT NULL, history_hash TEXT NOT NULL,
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=900000),
 historical_micros INTEGER NOT NULL CHECK(historical_micros=1025204),
 historical_model_micros INTEGER NOT NULL CHECK(historical_model_micros=820504),
 fee_cushion_micros INTEGER NOT NULL CHECK(fee_cushion_micros=780000),
 spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros BETWEEN 0 AND 164320),
 model_micros INTEGER NOT NULL DEFAULT 0 CHECK(model_micros BETWEEN 0 AND 56320),
 inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND 5),
 outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND 5),
 address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND 0),
 model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND 1),
 lock_id TEXT, stopped_reason TEXT, created_at INTEGER NOT NULL,
 CHECK(historical_model_micros+model_micros<=876824),
 CHECK(historical_micros+fee_cushion_micros+spent_micros<=1969524)
);
CREATE TABLE IF NOT EXISTS whatsapp_continuation_review_r3_operations (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES whatsapp_continuation_review_r3_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')),
 status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0), outcome TEXT,
 input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS whatsapp_continuation_review_r3_operations_grant ON whatsapp_continuation_review_r3_operations(grant_id,kind);
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_predecessor BEFORE INSERT ON whatsapp_continuation_review_r3_grants
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_continuation_voice_grants p WHERE p.pilot_id=NEW.pilot_id AND p.version=5
 AND p.id=NEW.pilot_id||':quote-v2-handset-5' AND p.expires_at<=NEW.created_at AND p.expires_at<=NEW.starts_at
 AND p.lock_id IS NULL AND p.stopped_reason='model_uncertain' AND p.historical_micros=735124 AND p.historical_model_micros=595224
 AND p.fee_cushion_micros=280000 AND p.spent_micros=121120 AND p.model_micros=56320 AND p.inbound=3 AND p.outbound=3 AND p.address=0 AND p.model=1)
 OR NOT EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight p WHERE p.status='matched' AND p.finished_at<=NEW.created_at AND p.expires_at>=NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'closed predecessor and successful bounded preflight required'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_grant_update BEFORE UPDATE ON whatsapp_continuation_review_r3_grants
WHEN NEW.id!=OLD.id OR NEW.pilot_id!=OLD.pilot_id OR NEW.version!=OLD.version OR NEW.binding_hash!=OLD.binding_hash OR NEW.history_hash!=OLD.history_hash
 OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at OR NEW.created_at!=OLD.created_at
 OR NEW.historical_micros!=OLD.historical_micros OR NEW.historical_model_micros!=OLD.historical_model_micros OR NEW.fee_cushion_micros!=OLD.fee_cushion_micros
 OR NEW.spent_micros<OLD.spent_micros OR NEW.model_micros<OLD.model_micros OR NEW.inbound<OLD.inbound OR NEW.outbound<OLD.outbound
 OR NEW.address<OLD.address OR NEW.model<OLD.model OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS NULL)
BEGIN SELECT RAISE(ABORT,'review allowance immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_grant_delete BEFORE DELETE ON whatsapp_continuation_review_r3_grants BEGIN SELECT RAISE(ABORT,'review grant retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_operation_update BEFORE UPDATE ON whatsapp_continuation_review_r3_operations
WHEN OLD.status!='pending' OR NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.kind!=OLD.kind OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'review operation immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_review_r3_operation_delete BEFORE DELETE ON whatsapp_continuation_review_r3_operations BEGIN SELECT RAISE(ABORT,'review operation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_voice_grants_insert BEFORE INSERT ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_voice_grants_update BEFORE UPDATE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_voice_grants_delete BEFORE DELETE ON whatsapp_continuation_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_voice_operations_insert BEFORE INSERT ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_voice_operations_update BEFORE UPDATE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_voice_operations_delete BEFORE DELETE ON whatsapp_continuation_voice_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_voice_grants_insert BEFORE INSERT ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_voice_grants_update BEFORE UPDATE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_voice_grants_delete BEFORE DELETE ON whatsapp_voice_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_voice_attempts_insert BEFORE INSERT ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_voice_attempts_update BEFORE UPDATE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_voice_attempts_delete BEFORE DELETE ON whatsapp_voice_attempts WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'prior history retained'); END;

CREATE TRIGGER IF NOT EXISTS review_r3_reservation_predecessor BEFORE INSERT ON whatsapp_review_r3_preflight
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_review_preflight p WHERE p.id='edenmish-release-smoke-20261010-r1'
 AND p.status='failed' AND p.reserved_micros=56320
 AND p.request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'
 AND p.source_sha256='9463b47cce9e4ff77e49cb3640f6ae67789187f4d1a30630d14862b7a9de835f'
 AND p.finished_at IS NOT NULL AND p.finished_at>=p.created_at AND p.finished_at<=NEW.created_at)
 OR NOT EXISTS(SELECT 1 FROM whatsapp_review_r2_preflight p WHERE p.id='edenmish-release-smoke-20261011-r2'
 AND p.status='failed' AND p.reserved_micros=56320
 AND p.request_sha256='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3'
 AND p.source_sha256='531f995ae64dd7f64f61fcebf864cfa68f2cf9b31f3e08a92c3a28a3a821682d'
 AND p.finished_at IS NOT NULL AND p.finished_at>=p.created_at AND p.finished_at<=NEW.created_at)
 OR EXISTS(SELECT 1 FROM whatsapp_continuation_review_r2_grants)
 OR EXISTS(SELECT 1 FROM whatsapp_continuation_review_r2_operations)
 OR EXISTS(SELECT 1 FROM whatsapp_continuation_review_grants)
 OR EXISTS(SELECT 1 FROM whatsapp_continuation_review_operations)
BEGIN SELECT RAISE(ABORT,'failed r1/r2 holds and unused v6/v7 allocations required'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_review_preflight_insert BEFORE INSERT ON whatsapp_review_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_review_preflight_update BEFORE UPDATE ON whatsapp_review_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_review_preflight_delete BEFORE DELETE ON whatsapp_review_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_grants_insert BEFORE INSERT ON whatsapp_continuation_review_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_grants_update BEFORE UPDATE ON whatsapp_continuation_review_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_grants_delete BEFORE DELETE ON whatsapp_continuation_review_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_operations_insert BEFORE INSERT ON whatsapp_continuation_review_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_operations_update BEFORE UPDATE ON whatsapp_continuation_review_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_operations_delete BEFORE DELETE ON whatsapp_continuation_review_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r1 and unused v6 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_review_r2_preflight_insert BEFORE INSERT ON whatsapp_review_r2_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_review_r2_preflight_update BEFORE UPDATE ON whatsapp_review_r2_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_review_r2_preflight_delete BEFORE DELETE ON whatsapp_review_r2_preflight WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_r2_grants_insert BEFORE INSERT ON whatsapp_continuation_review_r2_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_r2_grants_update BEFORE UPDATE ON whatsapp_continuation_review_r2_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_r2_grants_delete BEFORE DELETE ON whatsapp_continuation_review_r2_grants WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_r2_operations_insert BEFORE INSERT ON whatsapp_continuation_review_r2_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_r2_operations_update BEFORE UPDATE ON whatsapp_continuation_review_r2_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;
CREATE TRIGGER IF NOT EXISTS review_r3_freeze_whatsapp_continuation_review_r2_operations_delete BEFORE DELETE ON whatsapp_continuation_review_r2_operations WHEN EXISTS(SELECT 1 FROM whatsapp_review_r3_preflight) BEGIN SELECT RAISE(ABORT,'r2 and unused v7 allocation retained'); END;


-- Independent disabled-by-default full-booking budget. Migration issues no grant.
-- Environment root + whole-grant allocations are retained forever: new IDs,
-- stops, expiry and failed IO never restore previously approved allowance.
CREATE TABLE IF NOT EXISTS whatsapp_full_booking_budgets (
 environment TEXT PRIMARY KEY CHECK(environment IN ('staging','production')),
 budget_id TEXT NOT NULL UNIQUE, binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
 cap_micros INTEGER NOT NULL CHECK(cap_micros BETWEEN 1 AND 100000000),
 retained_micros INTEGER NOT NULL CHECK(retained_micros>=0),
 allocated_micros INTEGER NOT NULL DEFAULT 0 CHECK(allocated_micros>=0),
 held_micros INTEGER NOT NULL DEFAULT 0 CHECK(held_micros>=0 AND held_micros<=allocated_micros),
 stopped_reason TEXT, created_at INTEGER NOT NULL,
 CHECK(retained_micros+allocated_micros<=cap_micros)
);
CREATE TABLE IF NOT EXISTS whatsapp_full_booking_grants (
 id TEXT PRIMARY KEY, environment TEXT NOT NULL REFERENCES whatsapp_full_booking_budgets(environment),
 budget_id TEXT NOT NULL, binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
 root_binding TEXT NOT NULL CHECK(length(root_binding)=64), source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=86400000),
 allocation_micros INTEGER NOT NULL CHECK(allocation_micros>0),
 spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros BETWEEN 0 AND allocation_micros),
 inbound_limit INTEGER NOT NULL CHECK(inbound_limit BETWEEN 0 AND 1000), outbound_limit INTEGER NOT NULL CHECK(outbound_limit BETWEEN 0 AND 1000),
 address_limit INTEGER NOT NULL CHECK(address_limit BETWEEN 0 AND 100), model_limit INTEGER NOT NULL CHECK(model_limit BETWEEN 0 AND 100),
 inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND inbound_limit), outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND outbound_limit),
 address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND address_limit), model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND model_limit),
 stopped_reason TEXT, stopped_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_full_booking_operations (
 grant_id TEXT NOT NULL REFERENCES whatsapp_full_booking_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')), operation_key TEXT NOT NULL,
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
 status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
 diagnostics_json TEXT CHECK(diagnostics_json IS NULL OR (length(diagnostics_json)<=4096 AND json_valid(diagnostics_json))),
 created_at INTEGER NOT NULL, finished_at INTEGER CHECK(finished_at IS NULL OR finished_at>=created_at),
 PRIMARY KEY(grant_id,kind,operation_key)
);
CREATE TRIGGER IF NOT EXISTS whatsapp_full_budget_no_replace BEFORE INSERT ON whatsapp_full_booking_budgets
WHEN EXISTS(SELECT 1 FROM whatsapp_full_booking_budgets WHERE environment=NEW.environment)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_no_replace BEFORE INSERT ON whatsapp_full_booking_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_full_booking_grants WHERE id=NEW.id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_budget_update BEFORE UPDATE ON whatsapp_full_booking_budgets
WHEN NEW.environment!=OLD.environment OR NEW.budget_id!=OLD.budget_id OR NEW.binding_hash!=OLD.binding_hash OR NEW.cap_micros!=OLD.cap_micros
 OR NEW.retained_micros!=OLD.retained_micros OR NEW.created_at!=OLD.created_at OR NEW.allocated_micros<OLD.allocated_micros OR NEW.held_micros<OLD.held_micros
 OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS NOT OLD.stopped_reason)
BEGIN SELECT RAISE(ABORT,'full booking budget immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_budget_delete BEFORE DELETE ON whatsapp_full_booking_budgets BEGIN SELECT RAISE(ABORT,'full booking budget retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_insert BEFORE INSERT ON whatsapp_full_booking_grants
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_grants WHERE id=NEW.id) AND (
 NEW.spent_micros!=0 OR NEW.inbound!=0 OR NEW.outbound!=0 OR NEW.address!=0 OR NEW.model!=0 OR NEW.stopped_reason IS NOT NULL OR NEW.stopped_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_budgets b WHERE b.environment=NEW.environment AND b.budget_id=NEW.budget_id AND b.binding_hash=NEW.root_binding
 AND b.stopped_reason IS NULL AND b.retained_micros+b.allocated_micros+NEW.allocation_micros<=b.cap_micros))
BEGIN SELECT RAISE(ABORT,'full booking grant allocation refused'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_allocate AFTER INSERT ON whatsapp_full_booking_grants
BEGIN UPDATE whatsapp_full_booking_budgets SET allocated_micros=allocated_micros+NEW.allocation_micros WHERE environment=NEW.environment; END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_update BEFORE UPDATE ON whatsapp_full_booking_grants
WHEN NEW.id!=OLD.id OR NEW.environment!=OLD.environment OR NEW.budget_id!=OLD.budget_id OR NEW.binding_hash!=OLD.binding_hash OR NEW.root_binding!=OLD.root_binding
 OR NEW.source_sha256!=OLD.source_sha256 OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at OR NEW.allocation_micros!=OLD.allocation_micros
 OR NEW.inbound_limit!=OLD.inbound_limit OR NEW.outbound_limit!=OLD.outbound_limit OR NEW.address_limit!=OLD.address_limit OR NEW.model_limit!=OLD.model_limit
 OR NEW.created_at!=OLD.created_at OR NEW.spent_micros<OLD.spent_micros OR NEW.inbound<OLD.inbound OR NEW.outbound<OLD.outbound OR NEW.address<OLD.address OR NEW.model<OLD.model
 OR (OLD.stopped_reason IS NOT NULL AND (NEW.stopped_reason IS NOT OLD.stopped_reason OR NEW.stopped_at IS NOT OLD.stopped_at))
BEGIN SELECT RAISE(ABORT,'full booking grant immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_delete BEFORE DELETE ON whatsapp_full_booking_grants BEGIN SELECT RAISE(ABORT,'full booking grant retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_insert BEFORE INSERT ON whatsapp_full_booking_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_full_booking_operations WHERE grant_id=NEW.grant_id AND kind=NEW.kind AND operation_key=NEW.operation_key)
 OR NEW.status!='pending' OR NEW.finished_at IS NOT NULL OR NEW.diagnostics_json IS NOT NULL
 OR NEW.reserved_micros!=CASE NEW.kind WHEN 'inbound' THEN 10300 WHEN 'outbound' THEN 11300 WHEN 'address' THEN 32000 WHEN 'model' THEN 56320 END
 OR NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_grants g JOIN whatsapp_full_booking_budgets b ON b.environment=g.environment WHERE g.id=NEW.grant_id
 AND g.stopped_reason IS NULL AND b.stopped_reason IS NULL AND NEW.created_at>=g.starts_at AND NEW.created_at<g.expires_at
 AND g.spent_micros+NEW.reserved_micros<=g.allocation_micros
 AND CASE NEW.kind WHEN 'inbound' THEN g.inbound<g.inbound_limit WHEN 'outbound' THEN g.outbound<g.outbound_limit WHEN 'address' THEN g.address<g.address_limit WHEN 'model' THEN g.model<g.model_limit END)
BEGIN SELECT RAISE(ABORT,'full booking operation refused'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_hold AFTER INSERT ON whatsapp_full_booking_operations
BEGIN
 UPDATE whatsapp_full_booking_grants SET spent_micros=spent_micros+NEW.reserved_micros,
 inbound=inbound+(NEW.kind='inbound'),outbound=outbound+(NEW.kind='outbound'),address=address+(NEW.kind='address'),model=model+(NEW.kind='model') WHERE id=NEW.grant_id;
 UPDATE whatsapp_full_booking_budgets SET held_micros=held_micros+NEW.reserved_micros WHERE environment=(SELECT environment FROM whatsapp_full_booking_grants WHERE id=NEW.grant_id);
END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_update BEFORE UPDATE ON whatsapp_full_booking_operations
WHEN OLD.status!='pending' OR NEW.status NOT IN ('settled','uncertain') OR NEW.finished_at IS NULL
 OR NEW.grant_id!=OLD.grant_id OR NEW.kind!=OLD.kind OR NEW.operation_key!=OLD.operation_key OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'full booking operation immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_delete BEFORE DELETE ON whatsapp_full_booking_operations BEGIN SELECT RAISE(ABORT,'full booking hold retained'); END;

-- Separate full-booking ingress authority. Payloads contain identifiers/times,
-- never message bodies. Conversation retention may cascade these transient rows.
CREATE TABLE IF NOT EXISTS whatsapp_booking_full_fences (
 conversation_id TEXT PRIMARY KEY REFERENCES whatsapp_booking_conversations(id) ON DELETE CASCADE,
 grant_id TEXT NOT NULL REFERENCES whatsapp_full_booking_grants(id), epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0),
 latest_event_at INTEGER NOT NULL DEFAULT 0 CHECK(latest_event_at>=0), latest_event_key TEXT,
 stopped_at INTEGER, stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN ('operator_stop','customer_takeover','manual_takeover','ambiguous_order','model_failure','provider_failure'))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_full_fence_update BEFORE UPDATE ON whatsapp_booking_full_fences
WHEN NEW.conversation_id!=OLD.conversation_id OR NEW.grant_id!=OLD.grant_id OR NEW.epoch<OLD.epoch OR NEW.latest_event_at<OLD.latest_event_at
 OR (OLD.stopped_at IS NOT NULL AND (NEW.stopped_at IS NOT OLD.stopped_at OR NEW.stop_reason IS NOT OLD.stop_reason))
BEGIN SELECT RAISE(ABORT,'full booking fence cannot rewind'); END;
CREATE TABLE IF NOT EXISTS whatsapp_booking_full_ingress (
 event_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES whatsapp_booking_conversations(id) ON DELETE CASCADE,
 event_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL CHECK(deadline_at>0 AND deadline_at<=created_at+30000)
);
CREATE TRIGGER IF NOT EXISTS whatsapp_full_ingress_update BEFORE UPDATE ON whatsapp_booking_full_ingress BEGIN SELECT RAISE(ABORT,'full booking ingress immutable'); END;
-- Disabled durable full-booking inbox. Queue envelopes contain IDs only.
-- Ciphertext is purged on terminal state; metadata supports duplicate suppression.
CREATE TABLE IF NOT EXISTS whatsapp_booking_jobs (
 id TEXT PRIMARY KEY CHECK(length(id)=64),
 grant_id TEXT NOT NULL REFERENCES whatsapp_full_booking_grants(id),
 conversation_id TEXT NOT NULL REFERENCES whatsapp_booking_conversations(id) ON DELETE CASCADE,
 event_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL CHECK(deadline_at>created_at AND deadline_at<=created_at+30000),
 payload_cipher TEXT CHECK(payload_cipher IS NULL OR length(payload_cipher)<=16000),
 state TEXT NOT NULL CHECK(state IN ('pending','processing','done','uncertain','expired','superseded')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease TEXT, lease_until INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 wakeups INTEGER NOT NULL DEFAULT 0 CHECK(wakeups BETWEEN 0 AND 3),
 next_wakeup_at INTEGER NOT NULL DEFAULT 0, published_at INTEGER,
 finished_at INTEGER, reason TEXT CHECK(reason IS NULL OR reason IN ('complete','superseded','expired','stopped','budget','attempt_limit','provider_uncertain','invalid_payload','backpressure','internal_failure')),
 CHECK(state IN ('pending','processing') OR payload_cipher IS NULL)
);
CREATE INDEX IF NOT EXISTS whatsapp_booking_jobs_pending ON whatsapp_booking_jobs(state,next_attempt_at,deadline_at);
CREATE INDEX IF NOT EXISTS whatsapp_booking_jobs_conversation ON whatsapp_booking_jobs(conversation_id,created_at);
CREATE TRIGGER IF NOT EXISTS whatsapp_booking_job_immutable BEFORE UPDATE ON whatsapp_booking_jobs
WHEN NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.conversation_id!=OLD.conversation_id
 OR NEW.event_at!=OLD.event_at OR NEW.created_at!=OLD.created_at OR NEW.deadline_at!=OLD.deadline_at
 OR NEW.attempts<OLD.attempts OR NEW.wakeups<OLD.wakeups
 OR (OLD.payload_cipher IS NULL AND NEW.payload_cipher IS NOT NULL)
 OR (NEW.payload_cipher IS NOT NULL AND NEW.payload_cipher IS NOT OLD.payload_cipher)
 OR (OLD.state NOT IN ('pending','processing') AND NEW.state!=OLD.state)
BEGIN SELECT RAISE(ABORT,'booking job cannot rewind'); END;

-- Migration 052: payment-rehearsal dispatch hold and retained audit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_rehearsal_run ON orders(rehearsal_run_id) WHERE rehearsal_run_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS rehearsal_identity_immutable
BEFORE UPDATE ON orders WHEN OLD.rehearsal_run_id IS NOT NULL AND (
 NEW.rehearsal_run_id IS NOT OLD.rehearsal_run_id OR NEW.rehearsal_created_at IS NOT OLD.rehearsal_created_at
 OR (OLD.rehearsal_closed_at IS NOT NULL AND NEW.rehearsal_closed_at IS NOT OLD.rehearsal_closed_at)
 OR (NEW.rehearsal_closed_at IS NOT NULL AND NEW.rehearsal_closed_at<OLD.rehearsal_created_at))
BEGIN SELECT RAISE(ABORT,'rehearsal identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_update
BEFORE UPDATE ON orders WHEN NEW.rehearsal_run_id IS NOT NULL AND (
 NEW.status IN ('to_pickup','picked_up','to_dropoff','delivered','failed')
 OR NEW.picked_up_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
 OR NEW.retained_by_driver IS NOT NULL OR NEW.pending_redelivery_json IS NOT NULL
 OR NEW.price IS NOT 1 OR NEW.currency IS NOT 'ILS'
 OR NEW.business_account_id IS NOT NULL OR NEW.wallet_reservation_id IS NOT NULL
 OR COALESCE(NEW.discount_amount,0)!=0 OR NEW.discount_code IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_insert
BEFORE INSERT ON orders WHEN NEW.rehearsal_run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'register payment rehearsal after canonical creation'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_keep_order
BEFORE DELETE ON orders WHEN OLD.rehearsal_run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'payment rehearsal audit must be retained'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_assignments_insert
BEFORE INSERT ON driver_assignments WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_assignments_update
BEFORE UPDATE ON driver_assignments WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_route_stops_insert
BEFORE INSERT ON driver_route_stops WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_route_stops_update
BEFORE UPDATE ON driver_route_stops WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_task_proofs_insert
BEFORE INSERT ON driver_task_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_task_proofs_update
BEFORE UPDATE ON driver_task_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_delivery_proofs_insert
BEFORE INSERT ON delivery_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_delivery_proofs_update
BEFORE UPDATE ON delivery_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_gps_pings_insert
BEFORE INSERT ON gps_pings WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_gps_pings_update
BEFORE UPDATE ON gps_pings WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;

-- Migration 053: single-use payment rehearsal capability
-- One immutable, authenticated rehearsal authority. Never populated by customer traffic.
CREATE TABLE payment_rehearsal_runs (
 id TEXT PRIMARY KEY, config_json TEXT NOT NULL, starts_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=1800000),
 created_at INTEGER NOT NULL, stopped_at INTEGER, order_token TEXT UNIQUE,
 charge_attempt_at INTEGER, email_attempts INTEGER NOT NULL DEFAULT 0 CHECK(email_attempts BETWEEN 0 AND 4)
);
CREATE TRIGGER rehearsal_run_immutable BEFORE UPDATE ON payment_rehearsal_runs
WHEN NEW.id IS NOT OLD.id OR NEW.config_json IS NOT OLD.config_json
 OR NEW.starts_at IS NOT OLD.starts_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS NOT OLD.stopped_at)
 OR (OLD.order_token IS NOT NULL AND NEW.order_token IS NOT OLD.order_token)
 OR (OLD.charge_attempt_at IS NOT NULL AND NEW.charge_attempt_at IS NOT OLD.charge_attempt_at)
 OR NEW.email_attempts<OLD.email_attempts
BEGIN SELECT RAISE(ABORT,'rehearsal run is immutable'); END;
CREATE TRIGGER rehearsal_run_keep BEFORE DELETE ON payment_rehearsal_runs
BEGIN SELECT RAISE(ABORT,'rehearsal run audit must be retained'); END;
-- Hold installation is in the SAME SQLite statement as canonical order INSERT.
-- No interval in which a committed rehearsal order is unmarked exists.
CREATE TRIGGER rehearsal_claimed_order_hold AFTER INSERT ON orders
WHEN EXISTS(SELECT 1 FROM payment_rehearsal_runs WHERE order_token=NEW.token)
BEGIN
 SELECT RAISE(ABORT,'rehearsal order ineligible') WHERE NEW.source_channel IS NOT 'whatsapp'
  OR NEW.status IS NOT 'priced' OR NEW.payment_status IS NOT 'none'
  OR EXISTS(SELECT 1 FROM payment_rehearsal_runs WHERE order_token=NEW.token
    AND (stopped_at IS NOT NULL OR NEW.created_at<starts_at OR NEW.created_at>=expires_at));
 UPDATE orders SET rehearsal_run_id=(SELECT id FROM payment_rehearsal_runs WHERE order_token=NEW.token),
  rehearsal_created_at=NEW.created_at WHERE id=NEW.id;
 INSERT INTO status_history(order_id,status,at,note) VALUES(NEW.id,NEW.status,NEW.created_at,'payment_rehearsal_registered:capability');
END;
