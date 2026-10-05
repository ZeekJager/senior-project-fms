-- =====================================================================
-- 007_tracking.sql
-- Architecture boundary: tracking.*
-- High-volume telemetry is partitioned by recorded_at with a DEFAULT
-- partition so the system remains operational before monthly partitions
-- are introduced.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS tracking;
REVOKE CREATE ON SCHEMA tracking FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE tracking.telemetry_flag_type AS ENUM
        ('speeding', 'idling', 'fuel_variance', 'route_deviation', 'geofence_violation', 'harsh_braking', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE tracking.telemetry_flag_status AS ENUM
        ('open', 'reviewed', 'dismissed', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tracking.vehicle_current_location (
    vehicle_id       BIGINT PRIMARY KEY REFERENCES fleet.vehicles(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    latitude         NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude        NUMERIC(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    speed_kmh        NUMERIC(8,2) CHECK (speed_kmh IS NULL OR speed_kmh >= 0),
    heading_degrees  NUMERIC(6,2) CHECK (heading_degrees IS NULL OR heading_degrees BETWEEN 0 AND 360),
    accuracy_m       NUMERIC(8,2) CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
    ignition_on      BOOLEAN,
    odometer_km     NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    source           VARCHAR(30) NOT NULL DEFAULT 'gps',
    recorded_at      TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tracking.gps_pings (
    id               BIGINT GENERATED ALWAYS AS IDENTITY,
    vehicle_id       BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    trip_id          BIGINT REFERENCES trip.trips(id)
                     ON DELETE SET NULL ON UPDATE CASCADE,
    gps_device_id    BIGINT REFERENCES integration.gps_devices(id)
                     ON DELETE SET NULL ON UPDATE CASCADE,
    latitude         NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude        NUMERIC(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    speed_kmh        NUMERIC(8,2) CHECK (speed_kmh IS NULL OR speed_kmh >= 0),
    heading_degrees  NUMERIC(6,2) CHECK (heading_degrees IS NULL OR heading_degrees BETWEEN 0 AND 360),
    altitude_m       NUMERIC(10,2),
    accuracy_m       NUMERIC(8,2) CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
    ignition_on      BOOLEAN,
    odometer_km     NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    source           VARCHAR(30) NOT NULL DEFAULT 'gps',
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (recorded_at, id)
) PARTITION BY RANGE (recorded_at);

CREATE TABLE IF NOT EXISTS tracking.gps_pings_default
PARTITION OF tracking.gps_pings DEFAULT;

CREATE TABLE IF NOT EXISTS tracking.telemetry_flags (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    trip_id            BIGINT REFERENCES trip.trips(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    flag_type          tracking.telemetry_flag_type NOT NULL,
    severity           VARCHAR(20) NOT NULL DEFAULT 'medium',
    observed_at        TIMESTAMPTZ NOT NULL,
    details            JSONB NOT NULL DEFAULT '{}'::JSONB,
    status             tracking.telemetry_flag_status NOT NULL DEFAULT 'open',
    reviewed_by        BIGINT REFERENCES auth.users(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    reviewed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_telemetry_severity
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT chk_telemetry_details
        CHECK (jsonb_typeof(details) = 'object')
);

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

CREATE OR REPLACE TRIGGER trg_tracking_gps_ping_updates_current
    AFTER INSERT ON tracking.gps_pings
    FOR EACH ROW EXECUTE FUNCTION tracking.update_current_location_from_ping();

CREATE OR REPLACE TRIGGER trg_tracking_flags_updated_at
    BEFORE UPDATE ON tracking.telemetry_flags
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TRIGGER IF EXISTS trg_tracking_gps_ping_updates_current ON tracking.gps_pings;
DROP FUNCTION IF EXISTS tracking.update_current_location_from_ping();
DROP TABLE IF EXISTS tracking.telemetry_flags;
DROP TABLE IF EXISTS tracking.gps_pings_default;
DROP TABLE IF EXISTS tracking.gps_pings;
DROP TABLE IF EXISTS tracking.vehicle_current_location;
DROP TYPE IF EXISTS tracking.telemetry_flag_status;
DROP TYPE IF EXISTS tracking.telemetry_flag_type;
DROP SCHEMA IF EXISTS tracking;
