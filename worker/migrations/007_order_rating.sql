-- 007: Customer delivery rating (1-5 stars).
-- Submitted from the v2 delivery-confirmation page (edenmish-v2/public/delivered.html)
-- via POST /api/orders/:token/rate. Idempotent-safe ALTER: only adds the column on
-- DBs that predate it. schema.sql already includes it for fresh-DB setup.
ALTER TABLE orders ADD COLUMN rating INTEGER;
