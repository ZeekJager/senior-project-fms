-- =====================================================================
-- 015_driver_license_categories.sql
-- Driving licence classes as a list of European categories (FMS-16).
--
-- A European licence (EU Directive 2006/126/EC) carries several categories
-- at once, e.g. B and CE, so the single free-text license_category becomes
-- license_categories TEXT[], limited to the EU codes. A value of the old
-- column that is an EU code is carried over; anything else is dropped (no
-- production data existed when this was written).
-- =====================================================================

-- +migrate Up

ALTER TABLE fleet.drivers
    ADD COLUMN IF NOT EXISTS license_categories TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'fleet' AND table_name = 'drivers' AND column_name = 'license_category') THEN
        UPDATE fleet.drivers
           SET license_categories = ARRAY[upper(trim(license_category))]
         WHERE upper(trim(license_category)) IN
               ('AM','A1','A2','A','B1','B','BE','C1','C1E','C','CE','D1','D1E','D','DE');
        ALTER TABLE fleet.drivers DROP COLUMN license_category;
    END IF;
END $$;

ALTER TABLE fleet.drivers DROP CONSTRAINT IF EXISTS chk_driver_license_categories;
ALTER TABLE fleet.drivers
    ADD CONSTRAINT chk_driver_license_categories CHECK (
        license_categories <@ ARRAY['AM','A1','A2','A','B1','B','BE','C1','C1E','C','CE','D1','D1E','D','DE']::TEXT[]
    );

-- +migrate Down

ALTER TABLE fleet.drivers DROP CONSTRAINT IF EXISTS chk_driver_license_categories;
ALTER TABLE fleet.drivers ADD COLUMN IF NOT EXISTS license_category VARCHAR(50);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'fleet' AND table_name = 'drivers' AND column_name = 'license_categories') THEN
        UPDATE fleet.drivers SET license_category = array_to_string(license_categories, ',')
         WHERE cardinality(license_categories) > 0;
        ALTER TABLE fleet.drivers DROP COLUMN license_categories;
    END IF;
END $$;
