-- =====================================================================
-- 089_meter_source_trip.sql
-- Odometer readings from trips (FMS-165, docs/meter-readings.md).
--
-- fleet.meter_source (FMS-126, migration 038) gains `trip`: the odometer a
-- driver types when starting or ending a trip. Its own migration: a new enum
-- value cannot be used in the transaction that adds it, and 090 uses it.
-- =====================================================================

-- +migrate Up

ALTER TYPE fleet.meter_source ADD VALUE IF NOT EXISTS 'trip';

-- +migrate Down

-- An enum value cannot be dropped: the type is made again without it. A reading a driver typed on a trip keeps its
-- place as a manual one (a person typed it), with its reference.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'fleet' AND t.typname = 'meter_source' AND e.enumlabel = 'trip') THEN
        UPDATE fleet.meter_readings SET source = 'manual' WHERE source::text = 'trip';
        -- The one-reading-per-record index names source values in its predicate: made again after the type.
        DROP INDEX IF EXISTS fleet.ux_meter_readings_source_record;
        ALTER TYPE fleet.meter_source RENAME TO meter_source_trip;
        CREATE TYPE fleet.meter_source AS ENUM ('fuel_log', 'maintenance', 'telematics', 'gps_derived', 'manual');
        ALTER TABLE fleet.meter_readings
            ALTER COLUMN source TYPE fleet.meter_source USING source::text::fleet.meter_source;
        DROP TYPE fleet.meter_source_trip;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_readings_source_record
            ON fleet.meter_readings(vehicle_id, meter, source, source_ref)
            WHERE source IN ('fuel_log', 'maintenance', 'gps_derived');
    END IF;
END $$;
