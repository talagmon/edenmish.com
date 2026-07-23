-- Expand the durable delivery notification outbox to retained-package failures.
--
-- SQLite cannot alter a CHECK constraint in place, so rebuild the table while
-- preserving every existing delivered-notification job and its retry/lease state.

CREATE TABLE delivery_notification_outbox_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  transition TEXT NOT NULL CHECK(transition IN ('delivered','delivery_failed_retained')),
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
  UNIQUE(order_id, transition, channel, template),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

INSERT INTO delivery_notification_outbox_v2 (
  id, order_id, transition, event_id, channel, template, state, attempt_count,
  next_attempt_at, lease_token, lease_expires_at, last_error, created_at,
  updated_at, sent_at
)
SELECT
  id, order_id, transition, event_id, channel, template, state, attempt_count,
  next_attempt_at, lease_token, lease_expires_at, last_error, created_at,
  updated_at, sent_at
FROM delivery_notification_outbox;

DROP TABLE delivery_notification_outbox;
ALTER TABLE delivery_notification_outbox_v2 RENAME TO delivery_notification_outbox;

CREATE INDEX idx_delivery_notification_outbox_due
  ON delivery_notification_outbox(state, next_attempt_at, lease_expires_at, id);
