-- Persist fields already accepted and priced by POST /api/orders.
-- Required by ops SLA calculations, service analytics, and customer tracking.
ALTER TABLE orders ADD COLUMN when_date TEXT;
ALTER TABLE orders ADD COLUMN when_hour INTEGER;
ALTER TABLE orders ADD COLUMN service TEXT;
ALTER TABLE orders ADD COLUMN size TEXT;
