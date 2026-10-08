ALTER TABLE orders ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'website';

-- Disabled incoming booking adapter. No raw inbound message bodies retained.
CREATE TABLE IF NOT EXISTS whatsapp_booking_conversations (
  id TEXT PRIMARY KEY,
  sender_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  recipient TEXT,
  state_json TEXT NOT NULL,
  phase TEXT NOT NULL,
  order_token TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id),
  last_event_at INTEGER NOT NULL DEFAULT 0,
  last_customer_at INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER,
  confirmed_at INTEGER,
  confirmed_revision INTEGER,
  confirmed_price INTEGER,
  lock_id TEXT,
  lock_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_booking_events (
  event_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_booking_replies (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES whatsapp_booking_conversations(id),
  body TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  kind TEXT NOT NULL DEFAULT 'prompt',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS whatsapp_booking_replies_pending ON whatsapp_booking_replies(state, created_at);
CREATE INDEX IF NOT EXISTS whatsapp_booking_events_expiry ON whatsapp_booking_events(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_booking_reply_provider ON whatsapp_booking_replies(provider_ref) WHERE provider_ref IS NOT NULL;
