-- =====================================================================
-- 090_trip_odometer.sql
-- A trip's odometer at its start and end (FMS-165, docs/meter-readings.md).
--
-- trip.trips gains start_odometer_km (typed by the driver at START TRIP, or
-- the vehicle's own reading then) and end_odometer_km (typed at END TRIP).
-- A reading from a trip names the trip's end (`<trip>:start`, `<trip>:end`):
-- the one-reading-per-record index now covers `trip` too, so a redelivered
-- TripStarted or TripCompleted adds nothing.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.trips
    ADD COLUMN IF NOT EXISTS start_odometer_km NUMERIC(12,1) CHECK (start_odometer_km >= 0),
    ADD COLUMN IF NOT EXISTS end_odometer_km   NUMERIC(12,1) CHECK (end_odometer_km >= 0);

DROP INDEX IF EXISTS fleet.ux_meter_readings_source_record;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_readings_source_record
    ON fleet.meter_readings(vehicle_id, meter, source, source_ref)
    WHERE source IN ('fuel_log', 'maintenance', 'gps_derived', 'trip');

-- +migrate Down

DROP INDEX IF EXISTS fleet.ux_meter_readings_source_record;
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_readings_source_record
    ON fleet.meter_readings(vehicle_id, meter, source, source_ref)
    WHERE source IN ('fuel_log', 'maintenance', 'gps_derived');

ALTER TABLE trip.trips
    DROP COLUMN IF EXISTS end_odometer_km,
    DROP COLUMN IF EXISTS start_odometer_km;
