-- =====================================================================
-- 020_maintenance_records.sql
-- Maintenance record API (FMS-22).
--
-- * maintenance_records gets the version counter (If-Match on PUT/PATCH)
--   and who completed the work.
-- * inventory_parts keeps CHECK (stock_quantity >= 0) (FMS-23). A repair
--   that uses more of a part than the shelf count is still recorded in
--   full; the stock stops at zero and the API reports the shortfall in a
--   LOW_STOCK warning.
-- =====================================================================

-- +migrate Up

ALTER TABLE maintenance.maintenance_records ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maintenance.maintenance_records
    ADD COLUMN IF NOT EXISTS completed_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE TRIGGER trg_maintenance_records_version
    BEFORE UPDATE ON maintenance.maintenance_records
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

-- +migrate Down

DROP TRIGGER IF EXISTS trg_maintenance_records_version ON maintenance.maintenance_records;
ALTER TABLE maintenance.maintenance_records DROP COLUMN IF EXISTS completed_by;
ALTER TABLE maintenance.maintenance_records DROP COLUMN IF EXISTS version;
