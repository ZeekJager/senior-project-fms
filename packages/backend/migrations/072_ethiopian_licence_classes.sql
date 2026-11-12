-- =====================================================================
-- 072_ethiopian_licence_classes.sql
-- Ethiopian driving licence classes, matched to what a vehicle is
-- (SE-198, docs/driving-licences.md).
--
-- * fleet.drivers.license_categories: the domestic Ethiopian classes
--   (motorcycle, automobile, taxi_1, taxi_2, public_1, public_2,
--   dry_cargo_1-3, liquid_cargo_1-2, special) instead of the European codes
--   of migration 015. Each driver's European codes are converted:
--   AM/A1/A2/A -> motorcycle, B/BE/B1 -> automobile, C1/C1E -> dry_cargo_1,
--   C -> dry_cargo_2, CE -> dry_cargo_3, D1/D1E -> public_1, D/DE -> public_2.
-- * fleet.vehicles: what the licence check reads beyond the type, each
--   optional: body (passenger, dry_cargo, tanker, special), seats (passengers,
--   the driver not counted) and gross_weight_kg (the gross vehicle weight).
--   A vehicle without them is checked by its type alone.
-- =====================================================================

-- +migrate Up

ALTER TABLE fleet.vehicles
    ADD COLUMN IF NOT EXISTS body VARCHAR(12),
    ADD COLUMN IF NOT EXISTS seats SMALLINT,
    ADD COLUMN IF NOT EXISTS gross_weight_kg INTEGER;

DO $$ BEGIN
    ALTER TABLE fleet.vehicles ADD CONSTRAINT chk_vehicle_licence_details CHECK (
        (body IS NULL OR body IN ('passenger', 'dry_cargo', 'tanker', 'special'))
        AND (seats IS NULL OR seats BETWEEN 0 AND 120)
        AND (gross_weight_kg IS NULL OR gross_weight_kg BETWEEN 1 AND 100000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE fleet.drivers DROP CONSTRAINT IF EXISTS chk_driver_license_categories;

-- European codes to Ethiopian classes, in class order, without duplicates. Ethiopian values are kept (a second run).
UPDATE fleet.drivers d
   SET license_categories = ARRAY(
        SELECT DISTINCT m.cls
          FROM unnest(d.license_categories) AS held(code)
          JOIN (VALUES ('AM', 'motorcycle'), ('A1', 'motorcycle'), ('A2', 'motorcycle'), ('A', 'motorcycle'),
                       ('B1', 'automobile'), ('B', 'automobile'), ('BE', 'automobile'),
                       ('C1', 'dry_cargo_1'), ('C1E', 'dry_cargo_1'), ('C', 'dry_cargo_2'), ('CE', 'dry_cargo_3'),
                       ('D1', 'public_1'), ('D1E', 'public_1'), ('D', 'public_2'), ('DE', 'public_2'),
                       ('motorcycle', 'motorcycle'), ('automobile', 'automobile'), ('taxi_1', 'taxi_1'), ('taxi_2', 'taxi_2'),
                       ('public_1', 'public_1'), ('public_2', 'public_2'), ('dry_cargo_1', 'dry_cargo_1'),
                       ('dry_cargo_2', 'dry_cargo_2'), ('dry_cargo_3', 'dry_cargo_3'), ('liquid_cargo_1', 'liquid_cargo_1'),
                       ('liquid_cargo_2', 'liquid_cargo_2'), ('special', 'special')) AS m(code, cls)
            ON m.code = held.code
         ORDER BY m.cls)
 WHERE cardinality(d.license_categories) > 0;

-- Licence order (LICENSE_CATEGORIES), not alphabetical.
UPDATE fleet.drivers d
   SET license_categories = ARRAY(
        SELECT c FROM unnest(ARRAY['motorcycle', 'automobile', 'taxi_1', 'taxi_2', 'public_1', 'public_2', 'dry_cargo_1',
                                   'dry_cargo_2', 'dry_cargo_3', 'liquid_cargo_1', 'liquid_cargo_2', 'special']) WITH ORDINALITY AS o(c, n)
         WHERE c = ANY (d.license_categories) ORDER BY n)
 WHERE cardinality(d.license_categories) > 0;

ALTER TABLE fleet.drivers
    ADD CONSTRAINT chk_driver_license_categories CHECK (
        license_categories <@ ARRAY['motorcycle', 'automobile', 'taxi_1', 'taxi_2', 'public_1', 'public_2', 'dry_cargo_1',
                                    'dry_cargo_2', 'dry_cargo_3', 'liquid_cargo_1', 'liquid_cargo_2', 'special']::TEXT[]
    );

-- +migrate Down

ALTER TABLE fleet.drivers DROP CONSTRAINT IF EXISTS chk_driver_license_categories;

-- Back to the nearest European code each (taxi 1 and special had none: B1).
UPDATE fleet.drivers d
   SET license_categories = ARRAY(
        SELECT DISTINCT m.code
          FROM unnest(d.license_categories) AS held(cls)
          JOIN (VALUES ('motorcycle', 'A'), ('automobile', 'B'), ('taxi_1', 'B1'), ('taxi_2', 'B'), ('public_1', 'D1'),
                       ('public_2', 'D'), ('dry_cargo_1', 'C1'), ('dry_cargo_2', 'C'), ('dry_cargo_3', 'CE'),
                       ('liquid_cargo_1', 'C'), ('liquid_cargo_2', 'CE'), ('special', 'B1')) AS m(cls, code)
            ON m.cls = held.cls)
 WHERE cardinality(d.license_categories) > 0
   AND NOT (d.license_categories <@ ARRAY['AM','A1','A2','A','B1','B','BE','C1','C1E','C','CE','D1','D1E','D','DE']::TEXT[]);

ALTER TABLE fleet.drivers
    ADD CONSTRAINT chk_driver_license_categories CHECK (
        license_categories <@ ARRAY['AM','A1','A2','A','B1','B','BE','C1','C1E','C','CE','D1','D1E','D','DE']::TEXT[]
    );

ALTER TABLE fleet.vehicles DROP CONSTRAINT IF EXISTS chk_vehicle_licence_details;
ALTER TABLE fleet.vehicles DROP COLUMN IF EXISTS gross_weight_kg;
ALTER TABLE fleet.vehicles DROP COLUMN IF EXISTS seats;
ALTER TABLE fleet.vehicles DROP COLUMN IF EXISTS body;
