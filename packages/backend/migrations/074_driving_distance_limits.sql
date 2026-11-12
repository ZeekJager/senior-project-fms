-- =====================================================================
-- 074_driving_distance_limits.sql
-- Daily and weekly driving distance limits, by job load (FMS-156,
-- docs/driving-distance-limits.md).
--
-- * tracking.rule_thresholds: a driver is never assigned a trip that takes
--   their load-weighted distance past daily_distance_km (500) in a calendar
--   day in Addis Ababa, or weekly_distance_km (2500) Monday to Sunday. Each
--   trip counts its distance times its job load's weight (FMS-153): light
--   0.80, standard 1.00, heavy 1.50. The fleet's row and each depot's that
--   differs, as the other thresholds (035, 060, 068, 070). The defaults are
--   placeholders until the client confirms them.
-- * idx_trip_trips_driver_start: a driver's trips by start, which the rule
--   reads on every assignment and on the dispatch console.
-- =====================================================================

-- +migrate Up

ALTER TABLE tracking.rule_thresholds
    ADD COLUMN IF NOT EXISTS daily_distance_km SMALLINT NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS weekly_distance_km SMALLINT NOT NULL DEFAULT 2500,
    ADD COLUMN IF NOT EXISTS distance_weight_light NUMERIC(3, 2) NOT NULL DEFAULT 0.80,
    ADD COLUMN IF NOT EXISTS distance_weight_standard NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
    ADD COLUMN IF NOT EXISTS distance_weight_heavy NUMERIC(3, 2) NOT NULL DEFAULT 1.50;

-- A week holds at least a day's limit; a heavier job never counts for less.
DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_distance_limits CHECK (
        daily_distance_km BETWEEN 50 AND 2000
        AND weekly_distance_km BETWEEN 100 AND 10000
        AND weekly_distance_km >= daily_distance_km);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_distance_weights CHECK (
        distance_weight_light BETWEEN 0.50 AND 3.00
        AND distance_weight_standard BETWEEN 0.50 AND 3.00
        AND distance_weight_heavy BETWEEN 0.50 AND 3.00
        AND distance_weight_light <= distance_weight_standard
        AND distance_weight_standard <= distance_weight_heavy);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_trip_trips_driver_start
    ON trip.trips (driver_id, scheduled_start)
    WHERE driver_id IS NOT NULL AND status IN ('assigned', 'en_route', 'completed');

-- +migrate Down

DROP INDEX IF EXISTS trip.idx_trip_trips_driver_start;

ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_distance_weights;
ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_distance_limits;
ALTER TABLE tracking.rule_thresholds
    DROP COLUMN IF EXISTS distance_weight_heavy,
    DROP COLUMN IF EXISTS distance_weight_standard,
    DROP COLUMN IF EXISTS distance_weight_light,
    DROP COLUMN IF EXISTS weekly_distance_km,
    DROP COLUMN IF EXISTS daily_distance_km;
