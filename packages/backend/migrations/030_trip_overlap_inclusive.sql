-- =====================================================================
-- 030_trip_overlap_inclusive.sql
-- Trip assignment rules (FMS-31): a 0-minute gap is an overlap.
--
-- Migration 012's exclusion constraints compared '[)' ranges, so a trip
-- ending at 08:00 and the same driver's next trip starting at 08:00 did
-- not conflict. A driver (or vehicle) needs time between trips, so both
-- ends now count: '[]'. The API checks the same way first, to answer with
-- the conflicting trip; these constraints close the race between two
-- concurrent assignments.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.trips DROP CONSTRAINT IF EXISTS ex_trip_driver_overlap;
ALTER TABLE trip.trips
    ADD CONSTRAINT ex_trip_driver_overlap
    EXCLUDE USING gist (
        driver_id WITH =,
        tstzrange(scheduled_start, scheduled_end, '[]') WITH &&
    ) WHERE (status IN ('assigned', 'en_route'));

ALTER TABLE trip.trips DROP CONSTRAINT IF EXISTS ex_trip_vehicle_overlap;
ALTER TABLE trip.trips
    ADD CONSTRAINT ex_trip_vehicle_overlap
    EXCLUDE USING gist (
        vehicle_id WITH =,
        tstzrange(scheduled_start, scheduled_end, '[]') WITH &&
    ) WHERE (status IN ('assigned', 'en_route'));

-- +migrate Down

ALTER TABLE trip.trips DROP CONSTRAINT IF EXISTS ex_trip_vehicle_overlap;
ALTER TABLE trip.trips
    ADD CONSTRAINT ex_trip_vehicle_overlap
    EXCLUDE USING gist (
        vehicle_id WITH =,
        tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
    ) WHERE (status IN ('assigned', 'en_route'));

ALTER TABLE trip.trips DROP CONSTRAINT IF EXISTS ex_trip_driver_overlap;
ALTER TABLE trip.trips
    ADD CONSTRAINT ex_trip_driver_overlap
    EXCLUDE USING gist (
        driver_id WITH =,
        tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
    ) WHERE (status IN ('assigned', 'en_route'));
