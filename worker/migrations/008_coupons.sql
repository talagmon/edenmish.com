-- 008: Coupons (Shopify-defined discount codes, Worker-enforced).
-- Codes are created in Shopify Admin; the Worker syncs their definition into
-- `coupons`, validates + applies the discount server-side at order creation,
-- and records each use in `coupon_redemptions` so usage limits
-- (usage_limit / once-per-customer) are enforced via D1 counts.
-- Discount applies to the full price including surcharges; floor at 0.
-- Idempotent-safe on tables (CREATE TABLE IF NOT EXISTS). The ALTERs only run
-- on DBs that predate them. schema.sql already includes all of this for
-- fresh-DB setup.

-- Order snapshot: price stays the final charged amount; these record how we got there.
ALTER TABLE orders ADD COLUMN subtotal_price INTEGER;        -- price before discount (incl. surcharges)
ALTER TABLE orders ADD COLUMN discount_code TEXT;            -- normalized uppercase code applied
ALTER TABLE orders ADD COLUMN discount_amount INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_title TEXT;           -- human title snapshot from Shopify

-- Synced snapshot of Shopify discount codes. Shopify Admin is where codes are
-- created/edited; this table caches the definition the Worker validates against.
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

-- One row per successful redemption. Usage limits are enforced by counting rows
-- here (per code, and per code+customer_key for once-per-customer).
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
