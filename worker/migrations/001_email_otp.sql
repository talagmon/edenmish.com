-- 001: customer email + OTP verification
ALTER TABLE orders ADD COLUMN email TEXT;
ALTER TABLE orders ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN otp_hash TEXT;
ALTER TABLE orders ADD COLUMN otp_expires INTEGER;
