-- =====================================================================
-- 021_inventory_parts.sql
-- Spare parts inventory API (FMS-23).
--
-- * inventory_parts gets the version counter (If-Match on PUT).
-- * Part numbers are stored trimmed and upper case, as the API writes them.
-- * "Below reorder" (stock_quantity <= reorder_threshold) is the Workshop
--   Manager's daily question; a partial index keeps it cheap.
-- Stock stays CHECK (stock_quantity >= 0) from 005: a manual adjustment
-- that would go below zero is 409 CONFLICT_INSUFFICIENT_STOCK.
-- =====================================================================

-- +migrate Up

ALTER TABLE maintenance.inventory_parts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_maintenance_inventory_parts_version
    BEFORE UPDATE ON maintenance.inventory_parts
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

UPDATE maintenance.inventory_parts SET part_number = upper(btrim(part_number))
 WHERE part_number <> upper(btrim(part_number));

CREATE INDEX IF NOT EXISTS idx_inventory_parts_below_reorder
    ON maintenance.inventory_parts(depot_id)
    WHERE is_active AND stock_quantity <= reorder_threshold;

-- +migrate Down

DROP INDEX IF EXISTS maintenance.idx_inventory_parts_below_reorder;
DROP TRIGGER IF EXISTS trg_maintenance_inventory_parts_version ON maintenance.inventory_parts;
ALTER TABLE maintenance.inventory_parts DROP COLUMN IF EXISTS version;
