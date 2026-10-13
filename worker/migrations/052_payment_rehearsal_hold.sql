-- Payment-test audit marker; canonical payment remains real, physical dispatch is held.
ALTER TABLE orders ADD COLUMN rehearsal_run_id TEXT;
ALTER TABLE orders ADD COLUMN rehearsal_created_at INTEGER;
ALTER TABLE orders ADD COLUMN rehearsal_closed_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_rehearsal_run ON orders(rehearsal_run_id) WHERE rehearsal_run_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS rehearsal_identity_immutable
BEFORE UPDATE ON orders WHEN OLD.rehearsal_run_id IS NOT NULL AND (
 NEW.rehearsal_run_id IS NOT OLD.rehearsal_run_id OR NEW.rehearsal_created_at IS NOT OLD.rehearsal_created_at
 OR (OLD.rehearsal_closed_at IS NOT NULL AND NEW.rehearsal_closed_at IS NOT OLD.rehearsal_closed_at)
 OR (NEW.rehearsal_closed_at IS NOT NULL AND NEW.rehearsal_closed_at<OLD.rehearsal_created_at))
BEGIN SELECT RAISE(ABORT,'rehearsal identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_update
BEFORE UPDATE ON orders WHEN NEW.rehearsal_run_id IS NOT NULL AND (
 NEW.status IN ('to_pickup','picked_up','to_dropoff','delivered','failed')
 OR NEW.picked_up_at IS NOT NULL OR NEW.delivered_at IS NOT NULL
 OR NEW.retained_by_driver IS NOT NULL OR NEW.pending_redelivery_json IS NOT NULL
 OR NEW.price IS NOT 1 OR NEW.currency IS NOT 'ILS'
 OR NEW.business_account_id IS NOT NULL OR NEW.wallet_reservation_id IS NOT NULL
 OR COALESCE(NEW.discount_amount,0)!=0 OR NEW.discount_code IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_insert
BEFORE INSERT ON orders WHEN NEW.rehearsal_run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'register payment rehearsal after canonical creation'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_keep_order
BEFORE DELETE ON orders WHEN OLD.rehearsal_run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'payment rehearsal audit must be retained'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_assignments_insert
BEFORE INSERT ON driver_assignments WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_assignments_update
BEFORE UPDATE ON driver_assignments WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_route_stops_insert
BEFORE INSERT ON driver_route_stops WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_route_stops_update
BEFORE UPDATE ON driver_route_stops WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_task_proofs_insert
BEFORE INSERT ON driver_task_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_driver_task_proofs_update
BEFORE UPDATE ON driver_task_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_delivery_proofs_insert
BEFORE INSERT ON delivery_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_delivery_proofs_update
BEFORE UPDATE ON delivery_proofs WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_gps_pings_insert
BEFORE INSERT ON gps_pings WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_hold_gps_pings_update
BEFORE UPDATE ON gps_pings WHEN EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND rehearsal_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'payment rehearsal dispatch hold'); END;
