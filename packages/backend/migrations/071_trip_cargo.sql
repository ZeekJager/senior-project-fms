-- =====================================================================
-- 071_trip_cargo.sql
-- The load of a job on each trip (FMS-153, docs/job-load.md).
--
-- * trip.trips.cargo_weight_kg: what the trip carries, optional (most trips
--   have none recorded). Never above the assigned vehicle's
--   payload_capacity_kg when both are known: the API refuses it (400), as a
--   vehicle's capacity can change after the trip is planned.
-- * trip.trips.cargo_kind: general (the default), fragile, hazardous,
--   refrigerated or passengers.
--
-- The trip's job load (light, standard, heavy) is worked out on every read
-- from the plan, the schedule, the stops and the cargo's share of the
-- vehicle's payload (trip/domain/job-load.ts): it is never stored, so it
-- follows a change of any of them.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.trips
    ADD COLUMN IF NOT EXISTS cargo_weight_kg NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS cargo_kind VARCHAR(20) NOT NULL DEFAULT 'general';

DO $$ BEGIN
    ALTER TABLE trip.trips ADD CONSTRAINT chk_trip_cargo CHECK (
        (cargo_weight_kg IS NULL OR cargo_weight_kg > 0)
        AND cargo_kind IN ('general', 'fragile', 'hazardous', 'refrigerated', 'passengers'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- +migrate Down

ALTER TABLE trip.trips DROP CONSTRAINT IF EXISTS chk_trip_cargo;
ALTER TABLE trip.trips DROP COLUMN IF EXISTS cargo_kind;
ALTER TABLE trip.trips DROP COLUMN IF EXISTS cargo_weight_kg;
