-- =====================================================================
-- 062_trip_stop_completion.sql
-- Completing a trip's stops (FMS-95, docs/trip-stops.md).
--
-- - trip_stops.completed_at / completed_by: when a stop was marked done,
--   and by whom (the driver, or dispatch on their behalf). A stop reached
--   by GPS is `arrived` (FMS-86); completing it says the work there is
--   done. completed_by becomes null if that user is deleted.
-- - A completed stop has its completion time.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.trip_stops ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE trip.trip_stops ADD COLUMN IF NOT EXISTS completed_by BIGINT
    REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- Stops marked completed before this column existed get their arrival (or last change) as the time.
UPDATE trip.trip_stops SET completed_at = coalesce(actual_arrival, updated_at)
 WHERE status = 'completed' AND completed_at IS NULL;

DO $$ BEGIN
    ALTER TABLE trip.trip_stops
        ADD CONSTRAINT chk_trip_stop_completed CHECK (status <> 'completed' OR completed_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- +migrate Down

ALTER TABLE IF EXISTS trip.trip_stops DROP CONSTRAINT IF EXISTS chk_trip_stop_completed;
ALTER TABLE IF EXISTS trip.trip_stops DROP COLUMN IF EXISTS completed_by;
ALTER TABLE IF EXISTS trip.trip_stops DROP COLUMN IF EXISTS completed_at;
