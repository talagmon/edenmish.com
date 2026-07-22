-- Business-plan coupons: scoped coupon definitions, top-up price snapshots,
-- and redemption records keyed to wallet top-ups instead of delivery orders.

ALTER TABLE coupons ADD COLUMN scope TEXT NOT NULL DEFAULT 'delivery'
  CHECK(scope IN ('delivery','business_plan'));
ALTER TABLE coupons ADD COLUMN business_plan_ids TEXT;

ALTER TABLE wallet_topups ADD COLUMN payment_amount_agorot INTEGER;
ALTER TABLE wallet_topups ADD COLUMN discount_code TEXT;
ALTER TABLE wallet_topups ADD COLUMN discount_amount_agorot INTEGER NOT NULL DEFAULT 0
  CHECK(discount_amount_agorot >= 0);
ALTER TABLE wallet_topups ADD COLUMN discount_title TEXT;

UPDATE wallet_topups
SET payment_amount_agorot = amount_agorot
WHERE payment_amount_agorot IS NULL;

CREATE TABLE business_coupon_redemptions (
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

CREATE INDEX idx_business_coupon_redemptions_code
  ON business_coupon_redemptions(code);
CREATE INDEX idx_business_coupon_redemptions_customer
  ON business_coupon_redemptions(customer_key);
