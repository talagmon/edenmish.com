-- Extend route revisions from drop-off-only stops to mixed pickup/drop-off tasks.
-- Apply once after 014_driver_api_v1.sql.

ALTER TABLE driver_routes
  ADD COLUMN onboard_order_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE driver_route_stops
  ADD COLUMN task_type TEXT NOT NULL DEFAULT 'dropoff'
    CHECK(task_type IN ('pickup', 'dropoff'));

ALTER TABLE driver_route_stops
  ADD COLUMN required_predecessor_stop_id TEXT;

ALTER TABLE driver_route_stops
  ADD COLUMN service_duration_seconds INTEGER NOT NULL DEFAULT 300
    CHECK(service_duration_seconds >= 0 AND service_duration_seconds <= 7200);

-- Legacy route rows were drop-off-only and therefore represent packages that
-- were already collected. Preserve that meaning for existing revisions.
UPDATE driver_routes
SET onboard_order_ids_json = COALESCE((
  SELECT json_group_array(order_id)
  FROM driver_route_stops
  WHERE driver_route_stops.route_id = driver_routes.id
), '[]');
