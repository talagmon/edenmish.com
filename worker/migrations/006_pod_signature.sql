-- 006: Proof-of-delivery signature column.
-- The photo reuses the existing photo_url column (stores a client-resized base64 JPEG).
-- Idempotent-safe to run on a DB where schema.sql already created delivery_proofs
-- (this only adds the signature column if the DB predates it).
ALTER TABLE delivery_proofs ADD COLUMN signature TEXT;
