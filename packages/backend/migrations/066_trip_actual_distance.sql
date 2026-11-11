-- =====================================================================
-- 066_trip_actual_distance.sql
-- Each trip's actual distance, measured (FMS-145, docs/trip-distance.md).
--
-- - trips.actual_distance_source: how actual_distance_km was measured:
--   `odometer` (the vehicle's own device readings bracketing the trip) or
--   `gps` (the length of the GPS track). NULL with a distance: entered
--   before this card, by the seed or an import, not measured.
-- - trips.actual_distance_points: how many positions it was measured from;
--   more arriving later (a phone that was offline) means measure again.
-- - trips.actual_distance_measured_at: when it was last measured, a
--   distance found or not. NULL: never measured.
-- - A source needs a distance; a measurement needs its count.
-- - A partial index on completed trips still to measure, for the backfill.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.trips ADD COLUMN IF NOT EXISTS actual_distance_source VARCHAR(10);
ALTER TABLE trip.trips ADD COLUMN IF NOT EXISTS actual_distance_points INTEGER;
ALTER TABLE trip.trips ADD COLUMN IF NOT EXISTS actual_distance_measured_at TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE trip.trips
        ADD CONSTRAINT chk_trip_distance_source CHECK (
            actual_distance_source IS NULL
            OR (actual_distance_source IN ('odometer', 'gps') AND actual_distance_km IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.trips
        ADD CONSTRAINT chk_trip_distance_measured CHECK (
            (actual_distance_measured_at IS NULL) = (actual_distance_points IS NULL)
            AND (actual_distance_points IS NULL OR actual_distance_points >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_trip_trips_unmeasured
    ON trip.trips (actual_end)
    WHERE status = 'completed' AND actual_distance_km IS NULL AND actual_distance_measured_at IS NULL;

-- +migrate Down

DROP INDEX IF EXISTS trip.idx_trip_trips_unmeasured;
ALTER TABLE IF EXISTS trip.trips DROP CONSTRAINT IF EXISTS chk_trip_distance_measured;
ALTER TABLE IF EXISTS trip.trips DROP CONSTRAINT IF EXISTS chk_trip_distance_source;
ALTER TABLE IF EXISTS trip.trips DROP COLUMN IF EXISTS actual_distance_measured_at;
ALTER TABLE IF EXISTS trip.trips DROP COLUMN IF EXISTS actual_distance_points;
ALTER TABLE IF EXISTS trip.trips DROP COLUMN IF EXISTS actual_distance_source;
