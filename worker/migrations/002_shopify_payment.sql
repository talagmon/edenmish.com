-- Path 1: Shopify Draft Orders + PayPlus app (replaces direct PayPlus API).
-- Adds columns so the same orders table works today (immediate capture)
-- and later under Mesh/J5 (pre-auth + capture), without a second migration.

ALTER TABLE orders ADD COLUMN shopify_draft_order_id INTEGER;
ALTER TABLE orders ADD COLUMN shopify_order_id INTEGER;
ALTER TABLE orders ADD COLUMN payment_mode TEXT DEFAULT 'immediate'; -- 'immediate' (today) | 'preauth' (future Mesh)
ALTER TABLE orders ADD COLUMN authorized_amount INTEGER; -- used only in preauth mode

-- payments.payplus_id stays as a generic processor ref; alias for clarity in queries.
-- (No rename to avoid breaking existing rows.)
