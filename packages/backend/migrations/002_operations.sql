-- =====================================================================
-- Migration: 002_operations
-- Ticket:    FMS-02 — DB Migrations: Operations Tables
-- Target:    packages/backend/migrations/002_operations.sql
-- Spec:      docs/schema-fms.sql (MySQL) — translated to PostgreSQL here
-- Deps:      001_core_identity.sql (roles, depots, users, and the
--            set_updated_at() trigger function reused below)
--
-- Tables (everything in schema-fms.sql that 001 does not create):
--   vehicles, drivers, routes, trips, driver_attendance,
--   dvir_reports, maintenance_records, inventory_parts,
--   maintenance_parts, incident_reports, gps_pings, fuel_logs,
--   telemetry_flags, notifications, analytics_cache, audit_logs
--
-- MySQL -> PostgreSQL translation:
--   TINYINT(1)          -> BOOLEAN
--   JSON                -> JSONB
--   AUTO_INCREMENT      -> SERIAL / BIGSERIAL
--   ENUM(...)           -> CREATE TYPE ... AS ENUM (idempotent below)
--   SMALLINT UNSIGNED   -> SMALLINT + CHECK (>= 0)
--   TIMESTAMP / DATETIME-> TIMESTAMPTZ (matches 001)
--   ON UPDATE CURRENT_TIMESTAMP -> set_updated_at() trigger (from 001)
--
-- Rules honoured (CFG-1 Definition of Done / FMS-02 "Don't"):
--   * No float/double anywhere in fuel or money paths: fuel_ml,
--     cost_cents, unit_cost_cents, total_cost_cents are all INTEGER.
--   * Plain foreign keys (no ON DELETE CASCADE / SET NULL): core
--     entities are soft-deleted via is_active, never DELETEd.
--   * No indexes beyond primary and unique keys — query-specific
--     indexes are added in Wave 4 after profiling.
--
-- Up/Down split marker follows 001's convention.
-- =====================================================================

-- +migrate Up

-- ---------------------------------------------------------------------
-- ENUM types
-- Postgres has no CREATE TYPE IF NOT EXISTS; each DO block catches
-- duplicate_object so running Up twice stays idempotent (FMS-01 bar).
-- ---------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE trip_status AS ENUM
        ('scheduled', 'assigned', 'en_route', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'on_leave');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE dvir_type AS ENUM ('pre_trip', 'post_trip');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE incident_severity AS ENUM ('minor', 'major', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE telemetry_flag_type AS ENUM
        ('speeding', 'idling', 'fuel_variance');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- vehicles                                               (track-dispatch)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
    id                         SERIAL       PRIMARY KEY,
    plate_number               VARCHAR(50)  NOT NULL UNIQUE,
    type                       VARCHAR(50)  NOT NULL,
    capacity                   INTEGER      NOT NULL,
    depot_id                   INTEGER      NOT NULL REFERENCES depots(id),
    maintenance_flag           BOOLEAN      NOT NULL DEFAULT FALSE,
    fuel_efficiency_ml_per_km  INTEGER      NOT NULL,
    health_score               INTEGER,
    health_score_updated_at    TIMESTAMPTZ,
    is_active                  BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
CREATE TRIGGER trg_vehicles_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- drivers                                                (track-dispatch)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
    id              SERIAL        PRIMARY KEY,
    user_id         INTEGER       NOT NULL UNIQUE REFERENCES users(id),
    license_number  VARCHAR(100)  NOT NULL UNIQUE,
    license_expiry  DATE          NOT NULL,
    depot_id        INTEGER       NOT NULL REFERENCES depots(id),
    is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_drivers_updated_at ON drivers;
CREATE TRIGGER trg_drivers_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- routes                                                 (track-dispatch)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
    id           SERIAL        PRIMARY KEY,
    name         VARCHAR(255)  NOT NULL,
    origin       VARCHAR(255)  NOT NULL,
    destination  VARCHAR(255)  NOT NULL,
    distance_km  INTEGER       NOT NULL,
    depot_id     INTEGER       NOT NULL REFERENCES depots(id)
);

-- ---------------------------------------------------------------------
-- trips                                                  (track-dispatch)
-- status is a real ENUM: 'parked' (or any free text) is rejected.
-- version is the optimistic-locking counter.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    id               SERIAL       PRIMARY KEY,
    driver_id        INTEGER      NOT NULL REFERENCES drivers(id),
    vehicle_id       INTEGER      NOT NULL REFERENCES vehicles(id),
    route_id         INTEGER      NOT NULL REFERENCES routes(id),
    status           trip_status  NOT NULL DEFAULT 'scheduled',
    scheduled_start  TIMESTAMPTZ  NOT NULL,
    scheduled_end    TIMESTAMPTZ  NOT NULL,
    actual_start     TIMESTAMPTZ,
    actual_end       TIMESTAMPTZ,
    version          INTEGER      NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_trips_updated_at ON trips;
CREATE TRIGGER trg_trips_updated_at
    BEFORE UPDATE ON trips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- driver_attendance                                      (track-dispatch)
-- UNIQUE(driver_id, date) prevents double-logging a driver's day.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_attendance (
    id          SERIAL             PRIMARY KEY,
    driver_id   INTEGER            NOT NULL REFERENCES drivers(id),
    date        DATE               NOT NULL,
    status      attendance_status  NOT NULL,
    logged_by   INTEGER            NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (driver_id, date)
);

-- ---------------------------------------------------------------------
-- dvir_reports                                        (track-maintenance)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dvir_reports (
    id            SERIAL       PRIMARY KEY,
    vehicle_id    INTEGER      NOT NULL REFERENCES vehicles(id),
    driver_id     INTEGER      NOT NULL REFERENCES drivers(id),
    trip_id       INTEGER      NOT NULL REFERENCES trips(id),
    type          dvir_type    NOT NULL,
    items         JSONB        NOT NULL,
    issues_found  BOOLEAN      NOT NULL DEFAULT FALSE,
    submitted_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- maintenance_records                                 (track-maintenance)
-- total_cost_cents is INTEGER Ethiopian cents — no float.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_records (
    id                SERIAL       PRIMARY KEY,
    vehicle_id        INTEGER      NOT NULL REFERENCES vehicles(id),
    technician_id     INTEGER      NOT NULL REFERENCES users(id),
    description       TEXT         NOT NULL,
    labour_hours      INTEGER      NOT NULL,
    total_cost_cents  INTEGER      NOT NULL,
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- inventory_parts                                     (track-maintenance)
-- CHECK(stock_quantity >= 0) prevents negative stock at the DB level.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_parts (
    id              SERIAL        PRIMARY KEY,
    name            VARCHAR(255)  NOT NULL,
    stock_quantity  INTEGER       NOT NULL,
    reorder_level   INTEGER       NOT NULL,
    depot_id        INTEGER       NOT NULL REFERENCES depots(id),
    CHECK (stock_quantity >= 0)
);

-- ---------------------------------------------------------------------
-- maintenance_parts                                   (track-maintenance)
-- unit_cost_cents is INTEGER Ethiopian cents — no float.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_parts (
    id                     SERIAL   PRIMARY KEY,
    maintenance_record_id  INTEGER  NOT NULL REFERENCES maintenance_records(id),
    part_id                INTEGER  NOT NULL REFERENCES inventory_parts(id),
    quantity               INTEGER  NOT NULL,
    unit_cost_cents        INTEGER  NOT NULL
);

-- ---------------------------------------------------------------------
-- incident_reports                                    (track-maintenance)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_reports (
    id            SERIAL             PRIMARY KEY,
    driver_id     INTEGER            NOT NULL REFERENCES drivers(id),
    vehicle_id    INTEGER            NOT NULL REFERENCES vehicles(id),
    trip_id       INTEGER            NOT NULL REFERENCES trips(id),
    description   TEXT               NOT NULL,
    severity      incident_severity  NOT NULL,
    submitted_at  TIMESTAMPTZ        NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- gps_pings                                             (track-telemetry)
-- BIGSERIAL: highest-volume table in the schema.
-- Postgres has no SMALLINT UNSIGNED, so non-negativity is a CHECK.
-- lat/lng are fixed-point NUMERIC, not float.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gps_pings (
    id           BIGSERIAL      PRIMARY KEY,
    vehicle_id   INTEGER        NOT NULL REFERENCES vehicles(id),
    trip_id      INTEGER        NOT NULL REFERENCES trips(id),
    lat          NUMERIC(10,8)  NOT NULL,
    lng          NUMERIC(11,8)  NOT NULL,
    speed_kmh    SMALLINT       NOT NULL CHECK (speed_kmh >= 0),
    bearing      SMALLINT       CHECK (bearing >= 0),
    accuracy_m   INTEGER,
    recorded_at  TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- fuel_logs                                             (track-telemetry)
-- fuel_ml (integer millilitres) and cost_cents (integer Ethiopian
-- cents) are INTEGER NOT NULL — no DECIMAL, no FLOAT.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fuel_logs (
    id            SERIAL       PRIMARY KEY,
    driver_id     INTEGER      NOT NULL REFERENCES drivers(id),
    vehicle_id    INTEGER      NOT NULL REFERENCES vehicles(id),
    trip_id       INTEGER      NOT NULL REFERENCES trips(id),
    fuel_ml       INTEGER      NOT NULL,
    cost_cents    INTEGER      NOT NULL,
    odometer_km   INTEGER      NOT NULL,
    submitted_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- telemetry_flags                                       (track-telemetry)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_flags (
    id           SERIAL               PRIMARY KEY,
    vehicle_id   INTEGER              NOT NULL REFERENCES vehicles(id),
    trip_id      INTEGER              REFERENCES trips(id),
    flag_type    telemetry_flag_type  NOT NULL,
    started_at   TIMESTAMPTZ          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- notifications                                         (track-telemetry)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id          SERIAL       PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id),
    type        VARCHAR(50)  NOT NULL,
    message     TEXT         NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- analytics_cache                                       (track-telemetry)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_cache (
    id                        SERIAL       PRIMARY KEY,
    vehicle_id                INTEGER      NOT NULL REFERENCES vehicles(id),
    period                    VARCHAR(20)  NOT NULL,
    utilisation_pct           INTEGER      NOT NULL,
    cost_per_km_cents_per_km  INTEGER      NOT NULL,
    driver_on_time_pct        INTEGER      NOT NULL,
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_analytics_cache_updated_at ON analytics_cache;
CREATE TRIGGER trg_analytics_cache_updated_at
    BEFORE UPDATE ON analytics_cache
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- audit_logs                                                (track-core)
-- Append-only. correlation_id ties a row to the request that caused it.
--
-- Privileges: the app role (fms_app) may INSERT and SELECT but is
-- never granted UPDATE or DELETE. SELECT is kept because the Audit
-- Log UI (S-10) is a read-only view of this table; the card's
-- requirement is no UPDATE/DELETE.
--
-- Ownership gotcha: a Postgres table owner bypasses GRANT/REVOKE, so
-- this only bites if migrations run as a role OTHER than fms_app
-- (the docker stack runs them as fms_admin; fms_app is created in
-- docker/postgres/init and is a non-owner).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id              BIGSERIAL     PRIMARY KEY,
    table_name      VARCHAR(100)  NOT NULL,
    record_id       INTEGER       NOT NULL,
    action          VARCHAR(20)   NOT NULL,
    old_state       JSONB,
    new_state       JSONB,
    user_id         INTEGER       REFERENCES users(id),
    correlation_id  CHAR(36)      NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

REVOKE ALL ON audit_logs FROM PUBLIC;
REVOKE ALL ON audit_logs FROM fms_app;
GRANT SELECT, INSERT ON audit_logs TO fms_app;


-- +migrate Down

-- Drop in reverse FK order: dependents first, then what they reference,
-- then the enum types (which no table uses once the tables are gone).
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS analytics_cache;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS telemetry_flags;
DROP TABLE IF EXISTS fuel_logs;
DROP TABLE IF EXISTS gps_pings;
DROP TABLE IF EXISTS incident_reports;
DROP TABLE IF EXISTS maintenance_parts;
DROP TABLE IF EXISTS inventory_parts;
DROP TABLE IF EXISTS maintenance_records;
DROP TABLE IF EXISTS dvir_reports;
DROP TABLE IF EXISTS driver_attendance;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS routes;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS vehicles;
DROP TYPE IF EXISTS telemetry_flag_type;
DROP TYPE IF EXISTS incident_severity;
DROP TYPE IF EXISTS dvir_type;
DROP TYPE IF EXISTS attendance_status;
DROP TYPE IF EXISTS trip_status;
