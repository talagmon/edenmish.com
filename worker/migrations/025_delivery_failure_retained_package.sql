-- Retained packages after a failed delivery.
--
-- A driver who cannot complete a drop-off reports what happened to the package. Two of the
-- outcomes leave the package with the driver, so the order must stay live for dispatch even
-- though its canonical status is 'failed':
--
--   return_to_origin    -> route a drop-off back at the pickup address
--   hold_for_redelivery -> hold it until Ops supplies a corrected destination
--
-- 'left_with_alternate' releases the package, so it leaves this column NULL.
--
-- A nullable column is used rather than new order statuses on purpose: `status` is the shared
-- vocabulary read by the ops dashboard, the customer tracking timeline and both driver
-- clients, including the frozen Flutter rollback client. Adding a value it does not know is a
-- compatibility risk while Flutter is still the installed production app. Revisit once the
-- native cutover completes.
ALTER TABLE orders ADD COLUMN retained_by_driver TEXT;

-- When the package was retained (epoch ms). Drives the auto-return rule: a
-- hold_for_redelivery with no corrected destination reverts to return_to_origin after 24h so
-- an unpaid hold cannot ride around in a vehicle indefinitely.
ALTER TABLE orders ADD COLUMN retained_at INTEGER;

-- Dispatch reads this on every route sync, filtered to failed orders.
CREATE INDEX IF NOT EXISTS idx_orders_retained_by_driver
  ON orders (retained_by_driver)
  WHERE retained_by_driver IS NOT NULL;
