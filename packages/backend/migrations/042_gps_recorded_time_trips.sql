-- =====================================================================
-- 042_gps_recorded_time_trips.sql
-- Buffered pings belong to the trip they were recorded in (FMS-124).
--
-- * Ingestion finds a ping's trip from the ping's recorded_at (the trip
--   whose actual_start <= recorded_at and whose actual_end >= recorded_at
--   or is still open), for a driver's phone, a device and a provider
--   alike. Two partial indexes serve that lookup: a driver's and a
--   vehicle's trips by when they actually started.
-- * A ping of a trip that has already ended is history: it is stored
--   with its trip but must not become the vehicle's current position.
--   Ingestion says so for the INSERT it is about to run
--   (SET LOCAL fms.ping_history_only = 'on'); the trigger then leaves
--   tracking.vehicle_current_location alone. Anything else that inserts
--   pings, the seed included, is untouched.
-- =====================================================================

-- +migrate Up

CREATE INDEX IF NOT EXISTS idx_trips_driver_actual_start
    ON trip.trips(driver_id, actual_start)
    WHERE actual_start IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_vehicle_actual_start
    ON trip.trips(vehicle_id, actual_start)
    WHERE actual_start IS NOT NULL;

CREATE OR REPLACE FUNCTION tracking.update_current_location_from_ping()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('fms.ping_history_only', true) = 'on' THEN
        RETURN NEW;
    END IF;

    INSERT INTO tracking.vehicle_current_location (
        vehicle_id, latitude, longitude, speed_kmh, heading_degrees,
        accuracy_m, ignition_on, odometer_km, source, recorded_at, updated_at
    ) VALUES (
        NEW.vehicle_id, NEW.latitude, NEW.longitude, NEW.speed_kmh, NEW.heading_degrees,
        NEW.accuracy_m, NEW.ignition_on, NEW.odometer_km, NEW.source, NEW.recorded_at, CURRENT_TIMESTAMP
    )
    ON CONFLICT (vehicle_id) DO UPDATE
    SET latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        speed_kmh = EXCLUDED.speed_kmh,
        heading_degrees = EXCLUDED.heading_degrees,
        accuracy_m = EXCLUDED.accuracy_m,
        ignition_on = EXCLUDED.ignition_on,
        odometer_km = EXCLUDED.odometer_km,
        source = EXCLUDED.source,
        recorded_at = EXCLUDED.recorded_at,
        updated_at = CURRENT_TIMESTAMP
    WHERE EXCLUDED.recorded_at >= tracking.vehicle_current_location.recorded_at;

    RETURN NEW;
END;
$$;

-- +migrate Down

CREATE OR REPLACE FUNCTION tracking.update_current_location_from_ping()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO tracking.vehicle_current_location (
        vehicle_id, latitude, longitude, speed_kmh, heading_degrees,
        accuracy_m, ignition_on, odometer_km, source, recorded_at, updated_at
    ) VALUES (
        NEW.vehicle_id, NEW.latitude, NEW.longitude, NEW.speed_kmh, NEW.heading_degrees,
        NEW.accuracy_m, NEW.ignition_on, NEW.odometer_km, NEW.source, NEW.recorded_at, CURRENT_TIMESTAMP
    )
    ON CONFLICT (vehicle_id) DO UPDATE
    SET latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        speed_kmh = EXCLUDED.speed_kmh,
        heading_degrees = EXCLUDED.heading_degrees,
        accuracy_m = EXCLUDED.accuracy_m,
        ignition_on = EXCLUDED.ignition_on,
        odometer_km = EXCLUDED.odometer_km,
        source = EXCLUDED.source,
        recorded_at = EXCLUDED.recorded_at,
        updated_at = CURRENT_TIMESTAMP
    WHERE EXCLUDED.recorded_at >= tracking.vehicle_current_location.recorded_at;

    RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS trip.idx_trips_vehicle_actual_start;
DROP INDEX IF EXISTS trip.idx_trips_driver_actual_start;
