-- =====================================================================
-- 003_trip_route.sql
-- Architecture boundary: trip.*
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS trip;
REVOKE CREATE ON SCHEMA trip FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE trip.trip_status AS ENUM
        ('draft', 'scheduled', 'assigned', 'en_route', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS trip.routes (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    depot_id           BIGINT NOT NULL REFERENCES fleet.depots(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    origin_name        VARCHAR(255),
    destination_name   VARCHAR(255),
    origin_latitude    NUMERIC(9,6) CHECK (origin_latitude BETWEEN -90 AND 90),
    origin_longitude   NUMERIC(9,6) CHECK (origin_longitude BETWEEN -180 AND 180),
    destination_latitude  NUMERIC(9,6) CHECK (destination_latitude BETWEEN -90 AND 90),
    destination_longitude NUMERIC(9,6) CHECK (destination_longitude BETWEEN -180 AND 180),
    distance_km        NUMERIC(12,3) CHECK (distance_km IS NULL OR distance_km >= 0),
    estimated_duration_seconds INTEGER CHECK (estimated_duration_seconds IS NULL OR estimated_duration_seconds >= 0),
    geometry           JSONB,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_route_geometry CHECK (
        geometry IS NULL OR jsonb_typeof(geometry) = 'object'
    )
);

-- A trip is created first (POST /trips: route + schedule) and gets its
-- driver and vehicle later (POST /trips/:id/assign), so both are NULL
-- until the trip reaches 'assigned'; chk_trip_assignment enforces that.
CREATE TABLE IF NOT EXISTS trip.trips (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         BIGINT REFERENCES fleet.vehicles(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id          BIGINT REFERENCES fleet.drivers(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    route_id           BIGINT REFERENCES trip.routes(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    status             trip.trip_status NOT NULL DEFAULT 'draft',
    origin             VARCHAR(255),
    destination        VARCHAR(255),
    scheduled_start    TIMESTAMPTZ,
    scheduled_end      TIMESTAMPTZ,
    actual_start       TIMESTAMPTZ,
    actual_end         TIMESTAMPTZ,
    planned_distance_km NUMERIC(12,3) CHECK (planned_distance_km IS NULL OR planned_distance_km >= 0),
    actual_distance_km  NUMERIC(12,3) CHECK (actual_distance_km IS NULL OR actual_distance_km >= 0),
    planned_duration_seconds INTEGER CHECK (planned_duration_seconds IS NULL OR planned_duration_seconds >= 0),
    actual_duration_seconds  INTEGER CHECK (actual_duration_seconds IS NULL OR actual_duration_seconds >= 0),
    -- Optimistic-locking counter, bumped by trg_trip_trips_version.
    version            INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_trip_schedule CHECK (
        scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start
    ),
    CONSTRAINT chk_trip_actual CHECK (
        actual_end IS NULL OR actual_start IS NULL OR actual_end >= actual_start
    ),
    CONSTRAINT chk_trip_schedule_required CHECK (
        status IN ('draft', 'cancelled')
        OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)
    ),
    CONSTRAINT chk_trip_assignment CHECK (
        status IN ('draft', 'scheduled', 'cancelled')
        OR (driver_id IS NOT NULL AND vehicle_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS trip.trip_stops (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id           BIGINT NOT NULL REFERENCES trip.trips(id)
                      ON DELETE CASCADE ON UPDATE CASCADE,
    sequence_number   INTEGER NOT NULL,
    name              VARCHAR(255) NOT NULL,
    stop_type         VARCHAR(30) NOT NULL DEFAULT 'delivery',
    latitude          NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude         NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    planned_arrival   TIMESTAMPTZ,
    actual_arrival    TIMESTAMPTZ,
    status            VARCHAR(20) NOT NULL DEFAULT 'planned',
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (trip_id, sequence_number),
    CONSTRAINT chk_trip_stop_status
        CHECK (status IN ('planned', 'arrived', 'completed', 'skipped'))
);

CREATE OR REPLACE TRIGGER trg_trip_routes_updated_at
    BEFORE UPDATE ON trip.routes
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_trip_trips_updated_at
    BEFORE UPDATE ON trip.trips
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_trip_trips_version
    BEFORE UPDATE ON trip.trips
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE OR REPLACE TRIGGER trg_trip_stops_updated_at
    BEFORE UPDATE ON trip.trip_stops
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- fleet.dvir_reports.trip_id is created in 002, before trip.trips exists.
DO $$ BEGIN
    ALTER TABLE fleet.dvir_reports
        ADD CONSTRAINT fk_dvir_trip
        FOREIGN KEY (trip_id) REFERENCES trip.trips(id)
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- +migrate Down

ALTER TABLE IF EXISTS fleet.dvir_reports DROP CONSTRAINT IF EXISTS fk_dvir_trip;
DROP TABLE IF EXISTS trip.trip_stops;
DROP TABLE IF EXISTS trip.trips;
DROP TABLE IF EXISTS trip.routes;
DROP TYPE IF EXISTS trip.trip_status;
DROP SCHEMA IF EXISTS trip;
