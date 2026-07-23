-- 024: Persist explicit consent for a proof-of-delivery link on a phone channel.
-- Email remains the primary transactional POD channel.
ALTER TABLE orders ADD COLUMN phone_delivery_link_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN phone_delivery_link_opt_in_at INTEGER;
