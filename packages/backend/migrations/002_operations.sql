-- =====================================================================
-- Migration: 002_operations
-- Ticket:    FMS-02 — DB Migrations: Operations Tables
-- Target:    packages/backend/migrations/002_operations.sql
-- Tables:    vehicles, drivers, trips, fuel_logs, maintenance_records,
--            maintenance_parts, inventory_parts, gps_pings,
--            driver_attendance, audit_logs
-- Deps:      001_core_identity.sql (roles, depots, users,
--            set_updated_at() trigger function — reused below)
--
-- Dialect: PostgreSQL (confirmed via 001's dialect and this ticket's
-- resolution).
--
-- No schema-fms.sql exists for this ticket — greenfield project, so
-- this migration *is* the schema. Anything beyond what FMS-02's
-- ticket text explicitly requires (the ENUM values, the integer
-- money/volume columns, the UNIQUE/CHECK constraints, the audit_logs
-- privilege split) is a judgment call made here, flagged inline.
-- Flag anything you want changed before this lands.
--
-- Up/Down split marker follows 001's convention.
-- =====================================================================

-- +migrate Up

-- ---------------------------------------------------------------------
-- trip_status
-- Postgres has no "CREATE TYPE IF NOT EXISTS" — this DO block is the
-- standard idempotency workaround (catch duplicate_object), needed
-- because FMS-01's "running up twice is idempotent" bar applies here
-- too.
-- ---------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE trip_status AS ENUM
        ('scheduled', 'assigned', 'en_route', 'completed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- vehicles
-- depot_id is NOT NULL (every vehicle has a home depot) — unlike
-- users.depot_id, which is nullable for depot-unscoped admins. Flag
-- if vehicles should be allowed to exist depot-less mid-onboarding.
-- odometer_km is INTEGER, extending FMS-02's integer-only convention
-- (set for fuel/money) to mileage as well — no fractional km needed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
    id                   SERIAL       PRIMARY KEY,
    depot_id             INTEGER      NOT NULL REFERENCES depots(id)
                                       ON DELETE RESTRICT ON UPDATE CASCADE,
    registration_number  VARCHAR(50)  NOT NULL UNIQUE,
    vin                  VARCHAR(50)  UNIQUE,
    make                 VARCHAR(100) NOT NULL,
    model                VARCHAR(100) NOT NULL,
    year                 SMALLINT,
    odometer_km          INTEGER      NOT NULL DEFAULT 0,
    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
CREATE TRIGGER trg_vehicles_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- drivers
-- Modeled as a 1:1 profile extension of users (role_id = 'driver' on
-- the users side), not a standalone identity — avoids duplicating
-- email/password/name. license_expiry is NOT NULL since it's the
-- field document-expiry alerts would key off; flag if that's
-- premature for this ticket's scope.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
    id              SERIAL       PRIMARY KEY,
    user_id         INTEGER      NOT NULL UNIQUE REFERENCES users(id)
                                  ON DELETE RESTRICT ON UPDATE CASCADE,
    license_number  VARCHAR(50)  NOT NULL UNIQUE,
    license_expiry  DATE         NOT NULL,
    hire_date       DATE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_drivers_updated_at ON drivers;
CREATE TRIGGER trg_drivers_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- inventory_parts
-- Created ahead of maintenance_parts, which references it. depot_id
-- is nullable — a part may sit in a shared/central store rather than
-- one depot's stockroom.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_parts (
    id                 SERIAL       PRIMARY KEY,
    depot_id           INTEGER      REFERENCES depots(id)
                                     ON DELETE SET NULL ON UPDATE CASCADE,
    part_number        VARCHAR(100) NOT NULL UNIQUE,
    name               VARCHAR(255) NOT NULL,
    description        TEXT,
    unit_cost_cents    INTEGER,
    stock_quantity     INTEGER      NOT NULL DEFAULT 0
                                     CHECK (stock_quantity >= 0),
    reorder_threshold  INTEGER      NOT NULL DEFAULT 0,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_inventory_parts_updated_at ON inventory_parts;
CREATE TRIGGER trg_inventory_parts_updated_at
    BEFORE UPDATE ON inventory_parts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- trips
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    id               SERIAL       PRIMARY KEY,
    vehicle_id       INTEGER      NOT NULL REFERENCES vehicles(id)
                                   ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id        INTEGER      NOT NULL REFERENCES drivers(id)
                                   ON DELETE RESTRICT ON UPDATE CASCADE,
    status           trip_status  NOT NULL DEFAULT 'scheduled',
    origin           VARCHAR(255),
    destination      VARCHAR(255),
    scheduled_start  TIMESTAMPTZ,
    scheduled_end    TIMESTAMPTZ,
    actual_start     TIMESTAMPTZ,
    actual_end       TIMESTAMPTZ,
    distance_km      INTEGER,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_trips_updated_at ON trips;
CREATE TRIGGER trg_trips_updated_at
    BEFORE UPDATE ON trips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- fuel_logs
-- fuel_ml / cost_cents are INTEGER per the ticket — no DECIMAL/FLOAT.
-- driver_id is nullable: a fill-up may be a depot-level bulk purchase
-- with no single driver attached.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fuel_logs (
    id           SERIAL       PRIMARY KEY,
    vehicle_id   INTEGER      NOT NULL REFERENCES vehicles(id)
                               ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id    INTEGER      REFERENCES drivers(id)
                               ON DELETE SET NULL ON UPDATE CASCADE,
    fuel_ml      INTEGER      NOT NULL,
    cost_cents   INTEGER      NOT NULL,
    odometer_km  INTEGER,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_fuel_logs_updated_at ON fuel_logs;
CREATE TRIGGER trg_fuel_logs_updated_at
    BEFORE UPDATE ON fuel_logs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- maintenance_records
-- technician_id references users(id) directly rather than a separate
-- "technicians" table — FMS-02's table list didn't call for one, and
-- role_id = 'technician' on users already identifies who qualifies.
-- status is free-text, not an ENUM: the ticket gave fixed values for
-- trips.status but not this one, so no closed set was invented here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_records (
    id                SERIAL       PRIMARY KEY,
    vehicle_id        INTEGER      NOT NULL REFERENCES vehicles(id)
                                    ON DELETE RESTRICT ON UPDATE CASCADE,
    technician_id     INTEGER      REFERENCES users(id)
                                    ON DELETE SET NULL ON UPDATE CASCADE,
    description       TEXT,
    status            VARCHAR(20)  NOT NULL DEFAULT 'open',
    scheduled_date    DATE,
    completed_date    DATE,
    labor_hours       NUMERIC(6,2),
    total_cost_cents  INTEGER      NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_maintenance_records_updated_at ON maintenance_records;
CREATE TRIGGER trg_maintenance_records_updated_at
    BEFORE UPDATE ON maintenance_records
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- maintenance_parts
-- Line items under a maintenance_record. CASCADEs from the record
-- (delete a work order, its line items go too) but RESTRICTs on the
-- part (a part referenced in cost history can't just disappear).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_parts (
    id                      SERIAL       PRIMARY KEY,
    maintenance_record_id   INTEGER      NOT NULL REFERENCES maintenance_records(id)
                                          ON DELETE CASCADE ON UPDATE CASCADE,
    inventory_part_id       INTEGER      NOT NULL REFERENCES inventory_parts(id)
                                          ON DELETE RESTRICT ON UPDATE CASCADE,
    quantity                INTEGER      NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost_cents         INTEGER      NOT NULL,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_maintenance_parts_updated_at ON maintenance_parts;
CREATE TRIGGER trg_maintenance_parts_updated_at
    BEFORE UPDATE ON maintenance_parts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- gps_pings
-- BIGSERIAL, not SERIAL: this table grows far faster than any other
-- here (every vehicle, every few seconds) and can plausibly exceed
-- 2^31 rows over the system's life. No updated_at/trigger — pings are
-- append-only and never corrected after the fact.
-- vehicle_id CASCADEs on delete (the only core-entity FK in this file
-- that does) so decommissioning a vehicle isn't blocked by its own
-- telemetry history; trip_id is nullable since a ping can occur
-- outside an active trip.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gps_pings (
    id           BIGSERIAL     PRIMARY KEY,
    vehicle_id   INTEGER       NOT NULL REFERENCES vehicles(id)
                                ON DELETE CASCADE ON UPDATE CASCADE,
    trip_id      INTEGER       REFERENCES trips(id)
                                ON DELETE SET NULL ON UPDATE CASCADE,
    latitude     NUMERIC(9,6)  NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude    NUMERIC(9,6)  NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    speed_kmh    SMALLINT      NOT NULL CHECK (speed_kmh >= 0),
    recorded_at  TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- driver_attendance
-- status is free-text, same rationale as maintenance_records.status.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_attendance (
    id          SERIAL       PRIMARY KEY,
    driver_id   INTEGER      NOT NULL REFERENCES drivers(id)
                              ON DELETE RESTRICT ON UPDATE CASCADE,
    date        DATE         NOT NULL,
    status      VARCHAR(20)  NOT NULL DEFAULT 'present',
    notes       TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (driver_id, date)
);

DROP TRIGGER IF EXISTS trg_driver_attendance_updated_at ON driver_attendance;
CREATE TRIGGER trg_driver_attendance_updated_at
    BEFORE UPDATE ON driver_attendance
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- audit_logs
-- BIGSERIAL for the same volume reason as gps_pings. No updated_at —
-- rows are append-only by design, which the GRANT below is meant to
-- enforce. entity_id is NOT a foreign key: it points at rows across
-- many different tables, which Postgres can't express as one real FK.
--
-- IMPORTANT — two open items:
-- 1. Ownership gotcha: in Postgres the table owner always bypasses
--    GRANT/REVOKE. The REVOKE/GRANT pair below only produces the
--    "UPDATE fails with a permissions error" behaviour the ticket
--    tests for if THIS MIGRATION runs as a role other than fms_app —
--    otherwise fms_app owns the table it just created and the REVOKE
--    is a no-op against its own access. (The docker stack runs
--    migrations as fms_admin; see docker/postgres/init.)
-- 2. fms_app is the app DB role (created in docker/postgres/init).
--    The ticket says "INSERT only," so SELECT is deliberately left
--    ungranted below; if an audit-log viewer feature needs to read
--    these rows, that's a separate grant (or a separate read-only
--    role) to add once that's confirmed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id           BIGSERIAL     PRIMARY KEY,
    user_id      INTEGER       REFERENCES users(id)
                                ON DELETE SET NULL ON UPDATE CASCADE,
    action       VARCHAR(100)  NOT NULL,
    entity_type  VARCHAR(100),
    entity_id    INTEGER,
    details      JSONB,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

REVOKE ALL ON audit_logs FROM PUBLIC;
REVOKE ALL ON audit_logs FROM fms_app;
GRANT INSERT ON audit_logs TO fms_app;


-- +migrate Down

-- Drop in reverse FK order: leaf/dependent tables first, then the
-- tables they reference, then the enum type.
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS driver_attendance;
DROP TABLE IF EXISTS gps_pings;
DROP TABLE IF EXISTS maintenance_parts;
DROP TABLE IF EXISTS maintenance_records;
DROP TABLE IF EXISTS fuel_logs;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS inventory_parts;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS vehicles;
DROP TYPE IF EXISTS trip_status;
