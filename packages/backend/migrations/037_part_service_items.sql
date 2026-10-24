-- =====================================================================
-- 037_part_service_items.sql
-- What a stocked part renews (FMS-52, the predictive model's part history).
--
-- * service_item: a fixed list of the wearing parts and fluids the model
--   tracks (docs/ml-dataset.md). A new item is a migration, as the model's
--   inputs are fixed per model version.
-- * inventory_parts.service_item: the item a part renews when a completed
--   repair uses it (oil and its filter: engine_oil; a brake pad set:
--   brake_pads). NULL for parts that renew none (a wiper blade, a shock
--   absorber). A vehicle's last change of an item is then its latest
--   completed repair that used such a part: no new record to fill in.
-- * Index for "parts of each item", the lookup behind that query.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE maintenance.service_item AS ENUM
        ('engine_oil', 'air_filter', 'fuel_filter', 'coolant', 'brake_pads', 'brake_fluid',
         'clutch_fluid', 'tyres', 'battery', 'gearbox_oil', 'belts');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE maintenance.inventory_parts ADD COLUMN IF NOT EXISTS service_item maintenance.service_item;

CREATE INDEX IF NOT EXISTS idx_inventory_parts_service_item
    ON maintenance.inventory_parts(service_item)
    WHERE service_item IS NOT NULL;

-- +migrate Down

DROP INDEX IF EXISTS maintenance.idx_inventory_parts_service_item;
ALTER TABLE IF EXISTS maintenance.inventory_parts DROP COLUMN IF EXISTS service_item;
DROP TYPE IF EXISTS maintenance.service_item;
