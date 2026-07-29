-- Persist the customer-controlled batch row identifier on the delivery order.
-- The partial unique index makes repeated imports account-scoped and guarantees
-- that one external ID can never create two orders for the same business.

ALTER TABLE orders ADD COLUMN business_external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_business_external_id
  ON orders(business_account_id, business_external_id)
  WHERE business_account_id IS NOT NULL AND business_external_id IS NOT NULL;
