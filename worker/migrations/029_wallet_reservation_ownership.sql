-- Migration 029: Enforce one delivery order per non-null wallet reservation.
--
-- This index intentionally fails closed if historical duplicate references exist.
-- Run the documented preflight query in MIGRATIONS.md first; conflicting payment
-- records require operator review and must never be silently reassigned.

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_wallet_reservation_unique
  ON orders(wallet_reservation_id)
  WHERE wallet_reservation_id IS NOT NULL;
