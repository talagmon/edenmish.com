-- Harden WhatsApp delivery around approved templates, durable paid-order jobs,
-- and sanitized provider receipt state.
--
-- Preflight before applying:
-- SELECT provider_ref, COUNT(*) AS notification_count
-- FROM notifications
-- WHERE provider_ref IS NOT NULL
-- GROUP BY provider_ref
-- HAVING COUNT(*) > 1;

ALTER TABLE notifications ADD COLUMN provider_status TEXT;
ALTER TABLE notifications ADD COLUMN provider_updated_at INTEGER;

CREATE UNIQUE INDEX idx_notifications_provider_ref
  ON notifications(provider_ref)
  WHERE provider_ref IS NOT NULL;

-- SQLite cannot expand a CHECK constraint in place. Preserve every existing
-- delivery/failure job and its lease/retry state while adding payment_received.
CREATE TABLE delivery_notification_outbox_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  transition TEXT NOT NULL CHECK(transition IN (
    'delivered','delivery_failed_retained','payment_received'
  )),
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email', 'whatsapp')),
  template TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'sent', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  provider_ref TEXT,
  provider_status TEXT,
  provider_updated_at INTEGER,
  UNIQUE(order_id, transition, channel, template),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

INSERT INTO delivery_notification_outbox_v3 (
  id, order_id, transition, event_id, channel, template, state, attempt_count,
  next_attempt_at, lease_token, lease_expires_at, last_error, created_at,
  updated_at, sent_at, provider_ref, provider_status, provider_updated_at
)
SELECT
  id, order_id, transition, event_id, channel, template, state, attempt_count,
  next_attempt_at, lease_token, lease_expires_at, last_error, created_at,
  updated_at, sent_at, NULL, NULL, NULL
FROM delivery_notification_outbox;

DROP TABLE delivery_notification_outbox;
ALTER TABLE delivery_notification_outbox_v3 RENAME TO delivery_notification_outbox;

CREATE INDEX idx_delivery_notification_outbox_due
  ON delivery_notification_outbox(state, next_attempt_at, lease_expires_at, id);

CREATE UNIQUE INDEX idx_delivery_notification_outbox_provider_ref
  ON delivery_notification_outbox(provider_ref)
  WHERE provider_ref IS NOT NULL;
