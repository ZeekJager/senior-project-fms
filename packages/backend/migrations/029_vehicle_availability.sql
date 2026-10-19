-- =====================================================================
-- 029_vehicle_availability.sql
-- Vehicle status and availability (FMS-76).
--
-- * shared.vehicle_status loses `decommissioned`, a legacy value no
--   workflow sets: active, inactive (out of service), maintenance (in the
--   workshop), retired (final). A row still holding it becomes retired.
--   PostgreSQL cannot drop an enum value, so the type is replaced, and
--   analytics.vehicle_current_status, which depends on it, is re-created.
-- * fleet.vehicle_status_history: every status change with its reason,
--   who and when (the audit log has the row diff; this keeps the why), and
--   its source: a person, or the maintenance workflow as work starts and
--   ends (with the record's public id; maintenance owns the record, so no FK).
-- * fleet.trip_assignments: fleet's read model of the trips a vehicle or
--   driver is committed to (assigned or en route), kept from trip events
--   inside each trip change's transaction (the fleet.trip-assignments
--   projection) and rebuilt daily. Fleet answers "is it free between A and
--   B" from here without reading trip.* (CONVENTIONS rule 3). Both ends of a
--   window count: a trip ending at 08:00 makes the vehicle unavailable for
--   one starting at 08:00.
-- =====================================================================

-- +migrate Up

-- Replaces shared.vehicle_status (an enum value cannot be dropped), re-creating
-- the view that depends on it. Skipped when already done, so a re-run is safe.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'shared' AND t.typname = 'vehicle_status' AND e.enumlabel = 'decommissioned') THEN
        UPDATE fleet.vehicles SET status = 'retired', is_active = FALSE WHERE status::text = 'decommissioned';
        DROP VIEW IF EXISTS analytics.vehicle_current_status;
        ALTER TYPE shared.vehicle_status RENAME TO vehicle_status_legacy;
        CREATE TYPE shared.vehicle_status AS ENUM ('active', 'inactive', 'maintenance', 'retired');
        ALTER TABLE fleet.vehicles ALTER COLUMN status DROP DEFAULT;
        ALTER TABLE fleet.vehicles ALTER COLUMN status TYPE shared.vehicle_status USING status::text::shared.vehicle_status;
        ALTER TABLE fleet.vehicles ALTER COLUMN status SET DEFAULT 'active';
        DROP TYPE shared.vehicle_status_legacy;
        CREATE VIEW analytics.vehicle_current_status AS
        SELECT
            v.id AS vehicle_id,
            v.registration_number,
            v.make,
            v.model,
            v.status AS vehicle_status,
            v.maintenance_flag,
            v.health_score,
            d.name AS depot_name,
            vcl.latitude,
            vcl.longitude,
            vcl.speed_kmh,
            vcl.ignition_on,
            vcl.recorded_at AS location_recorded_at,
            active_trip.id AS active_trip_id,
            active_trip.status AS active_trip_status,
            active_trip.driver_id AS active_driver_id
        FROM fleet.vehicles v
        JOIN fleet.depots d ON d.id = v.depot_id
        LEFT JOIN tracking.vehicle_current_location vcl ON vcl.vehicle_id = v.id
        LEFT JOIN LATERAL (
            SELECT t.id, t.status, t.driver_id
            FROM trip.trips t
            WHERE t.vehicle_id = v.id
              AND t.status IN ('scheduled', 'assigned', 'en_route')
            ORDER BY t.scheduled_start NULLS LAST, t.created_at DESC
            LIMIT 1
        ) active_trip ON TRUE;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
            GRANT SELECT ON analytics.vehicle_current_status TO fms_app;
        END IF;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS fleet.vehicle_status_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id      BIGINT NOT NULL REFERENCES fleet.vehicles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    from_status     shared.vehicle_status NOT NULL,
    to_status       shared.vehicle_status NOT NULL,
    reason          VARCHAR(500),
    source          VARCHAR(20) NOT NULL DEFAULT 'manual',
    maintenance_record_id UUID,
    changed_by      BIGINT REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    correlation_id  UUID,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_vehicle_status_history_change CHECK (from_status <> to_status),
    CONSTRAINT chk_vehicle_status_history_source CHECK (source IN ('manual', 'maintenance')),
    CONSTRAINT chk_vehicle_status_history_record CHECK ((source = 'maintenance') = (maintenance_record_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_status_history_vehicle
    ON fleet.vehicle_status_history (vehicle_id, changed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fleet.trip_assignments (
    trip_id     UUID PRIMARY KEY,
    vehicle_id  BIGINT REFERENCES fleet.vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
    driver_id   BIGINT REFERENCES fleet.drivers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    status      VARCHAR(20) NOT NULL,
    during      TSTZRANGE NOT NULL,
    synced_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_trip_assignments_status CHECK (status IN ('assigned', 'en_route')),
    CONSTRAINT chk_trip_assignments_during CHECK (NOT isempty(during) AND lower(during) IS NOT NULL AND upper(during) IS NOT NULL)
);

-- btree_gist (migration 012) lets one GiST index combine the id and the window.
CREATE INDEX IF NOT EXISTS idx_trip_assignments_vehicle ON fleet.trip_assignments USING gist (vehicle_id, during);
CREATE INDEX IF NOT EXISTS idx_trip_assignments_driver ON fleet.trip_assignments USING gist (driver_id, during);

-- Start from the trips already assigned or under way; events keep it current from here.
INSERT INTO fleet.trip_assignments (trip_id, vehicle_id, driver_id, status, during)
SELECT public_id, vehicle_id, driver_id, status::text, tstzrange(scheduled_start, scheduled_end, '[]')
  FROM trip.trips
 WHERE status IN ('assigned', 'en_route') AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL
ON CONFLICT (trip_id) DO NOTHING;

-- +migrate Down

DROP TABLE IF EXISTS fleet.trip_assignments;
DROP TABLE IF EXISTS fleet.vehicle_status_history;

-- Replaces shared.vehicle_status (an enum value cannot be dropped), re-creating
-- the view that depends on it. Skipped when already done, so a re-run is safe.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'shared' AND t.typname = 'vehicle_status' AND e.enumlabel = 'decommissioned') THEN
        DROP VIEW IF EXISTS analytics.vehicle_current_status;
        ALTER TYPE shared.vehicle_status RENAME TO vehicle_status_legacy;
        CREATE TYPE shared.vehicle_status AS ENUM ('active', 'inactive', 'maintenance', 'retired', 'decommissioned');
        ALTER TABLE fleet.vehicles ALTER COLUMN status DROP DEFAULT;
        ALTER TABLE fleet.vehicles ALTER COLUMN status TYPE shared.vehicle_status USING status::text::shared.vehicle_status;
        ALTER TABLE fleet.vehicles ALTER COLUMN status SET DEFAULT 'active';
        DROP TYPE shared.vehicle_status_legacy;
        CREATE VIEW analytics.vehicle_current_status AS
        SELECT
            v.id AS vehicle_id,
            v.registration_number,
            v.make,
            v.model,
            v.status AS vehicle_status,
            v.maintenance_flag,
            v.health_score,
            d.name AS depot_name,
            vcl.latitude,
            vcl.longitude,
            vcl.speed_kmh,
            vcl.ignition_on,
            vcl.recorded_at AS location_recorded_at,
            active_trip.id AS active_trip_id,
            active_trip.status AS active_trip_status,
            active_trip.driver_id AS active_driver_id
        FROM fleet.vehicles v
        JOIN fleet.depots d ON d.id = v.depot_id
        LEFT JOIN tracking.vehicle_current_location vcl ON vcl.vehicle_id = v.id
        LEFT JOIN LATERAL (
            SELECT t.id, t.status, t.driver_id
            FROM trip.trips t
            WHERE t.vehicle_id = v.id
              AND t.status IN ('scheduled', 'assigned', 'en_route')
            ORDER BY t.scheduled_start NULLS LAST, t.created_at DESC
            LIMIT 1
        ) active_trip ON TRUE;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
            GRANT SELECT ON analytics.vehicle_current_status TO fms_app;
        END IF;
    END IF;
END $$;
