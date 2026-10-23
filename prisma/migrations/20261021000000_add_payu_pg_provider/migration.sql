-- Add PayU as a supported payment gateway.
ALTER TYPE pg_provider ADD VALUE IF NOT EXISTS 'PAYU';
