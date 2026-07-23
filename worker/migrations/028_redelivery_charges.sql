-- Purpose-specific payment state for a corrected-address redelivery.
--
-- The original delivery payment remains on orders/payments. A redelivery fee
-- gets its own immutable amount, Shopify Draft Order reference, and webhook
-- reconciliation lifecycle.

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
