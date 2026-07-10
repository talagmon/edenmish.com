-- Migration 009: Add invoice tracking columns to orders table
-- Stores GreenInvoice document number and URL when an invoice is generated.
-- Allows ops dashboard to display invoice status without capturing API responses.

ALTER TABLE orders ADD COLUMN invoice_number TEXT;
ALTER TABLE orders ADD COLUMN invoice_url TEXT;
