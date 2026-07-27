-- Migration 032: Privacy-safe, single-use paid conversion claims.
--
-- The browser keeps the raw random credential in sessionStorage. D1 stores only
-- its SHA-256 hash and no customer, contact, address, order-reference, or provider
-- identifier. A verified Shopify settlement makes the row redeemable once.

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
