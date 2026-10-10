-- =====================================================================
-- 018_document_expiry.sql
-- Expiry dates on documents (FMS-17).
--
-- A registration, licence or insurance document expires; FMS-26 warns
-- before it does. expires_on is the document's own expiry (from the paper),
-- distinct from retain_until, which is how long the file must be kept.
-- =====================================================================

-- +migrate Up

ALTER TABLE document.documents ADD COLUMN IF NOT EXISTS expires_on DATE;

-- "Live documents expiring before X", the FMS-26 query.
CREATE INDEX IF NOT EXISTS idx_document_expires_on
    ON document.documents(expires_on)
    WHERE deleted_at IS NULL AND expires_on IS NOT NULL;

-- +migrate Down

DROP INDEX IF EXISTS document.idx_document_expires_on;
ALTER TABLE document.documents DROP COLUMN IF EXISTS expires_on;
