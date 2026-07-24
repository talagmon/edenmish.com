-- Migration 031: Server-authoritative automatic first-delivery promotion.
--
-- Coupon definitions remain managed through the ops dashboard. Eligibility is
-- reserved before order creation or wallet mutation, so a coupon code is never
-- the security boundary.

ALTER TABLE coupons ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 0
  CHECK(auto_apply IN (0, 1));
ALTER TABLE coupons ADD COLUMN eligibility_rule TEXT
  CHECK(eligibility_rule IS NULL OR eligibility_rule = 'first_delivery');

ALTER TABLE coupon_redemptions ADD COLUMN promotion_claim_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_promotion_claim
  ON coupon_redemptions(promotion_claim_id)
  WHERE promotion_claim_id IS NOT NULL;

CREATE TABLE first_delivery_promotion_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_code TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  phone_key TEXT,
  email_key TEXT,
  business_account_id INTEGER,
  idempotency_key TEXT,
  order_id INTEGER UNIQUE,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK(status IN ('reserved', 'redeemed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (business_account_id) REFERENCES business_accounts(id)
);

-- These indexes serialize claims across every first-delivery promotion, not
-- merely one code, so switching the ops-managed launch code cannot grant a
-- second first-delivery benefit.
CREATE UNIQUE INDEX idx_first_delivery_claim_phone
  ON first_delivery_promotion_claims(phone_key)
  WHERE phone_key IS NOT NULL;
CREATE UNIQUE INDEX idx_first_delivery_claim_email
  ON first_delivery_promotion_claims(email_key)
  WHERE email_key IS NOT NULL;
CREATE UNIQUE INDEX idx_first_delivery_claim_business
  ON first_delivery_promotion_claims(business_account_id)
  WHERE business_account_id IS NOT NULL;
CREATE UNIQUE INDEX idx_first_delivery_claim_business_idempotency
  ON first_delivery_promotion_claims(business_account_id, idempotency_key)
  WHERE business_account_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_paid_phone
  ON orders(phone, payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_paid_email
  ON orders(email COLLATE NOCASE, payment_status);

-- Launch offer: 10% off one eligible first delivery. The end instant is exactly
-- 31 August 2026 23:59:59.999 Asia/Jerusalem (epoch ms 1788209999999).
INSERT OR IGNORE INTO coupons (
  code, title, value_type, value, status, starts_at, ends_at, usage_limit,
  applies_once_per_customer, scope, business_plan_ids, auto_apply,
  eligibility_rule, synced_at
) VALUES (
  'FIRST10-2026', '10% הנחה למשלוח ראשון', 'percentage', 10, 'active',
  NULL, 1788209999999, NULL, 1, 'delivery', NULL, 1,
  'first_delivery', CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
