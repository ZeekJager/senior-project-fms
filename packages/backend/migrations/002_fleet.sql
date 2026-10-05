-- =====================================================================
-- 002_fleet.sql
-- Architecture boundary: fleet.*
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS fleet;
REVOKE CREATE ON SCHEMA fleet FROM PUBLIC;

CREATE TABLE IF NOT EXISTS fleet.depots (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    code        VARCHAR(50) UNIQUE,
    address     TEXT,
    city        VARCHAR(120),
    country     VARCHAR(120),
    timezone    VARCHAR(100),
    latitude    NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude   NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    capacity    INTEGER CHECK (capacity IS NULL OR capacity >= 0),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fleet.vehicles (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    depot_id             BIGINT NOT NULL REFERENCES fleet.depots(id)
                         ON DELETE RESTRICT ON UPDATE CASCADE,
    registration_number  VARCHAR(50) NOT NULL,
    vin                  VARCHAR(50),
    vehicle_type         shared.vehicle_type NOT NULL DEFAULT 'other',
    fuel_type            shared.fuel_type NOT NULL DEFAULT 'other',
    make                 VARCHAR(100) NOT NULL,
    model                VARCHAR(100) NOT NULL,
    model_year           SMALLINT CHECK (model_year IS NULL OR model_year BETWEEN 1900 AND 2100),
    odometer_km          NUMERIC(12,1) NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
    payload_capacity_kg  NUMERIC(12,2) CHECK (payload_capacity_kg IS NULL OR payload_capacity_kg >= 0),
    status               shared.vehicle_status NOT NULL DEFAULT 'active',
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_fleet_vehicle_registration UNIQUE (registration_number),
    CONSTRAINT uq_fleet_vehicle_vin UNIQUE (vin)
);

CREATE TABLE IF NOT EXISTS fleet.drivers (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL UNIQUE REFERENCES auth.users(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    license_number   VARCHAR(100) NOT NULL UNIQUE,
    license_category VARCHAR(50),
    license_expiry   DATE NOT NULL,
    hire_date        DATE,
    emergency_phone  VARCHAR(50),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
);

CREATE TABLE IF NOT EXISTS fleet.driver_vehicle_assignments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id       BIGINT NOT NULL REFERENCES fleet.drivers(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    vehicle_id      BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    assignment_type VARCHAR(30) NOT NULL DEFAULT 'primary',
    assigned_from   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_until  TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_assignment_dates
        CHECK (assigned_until IS NULL OR assigned_until >= assigned_from),
    CONSTRAINT chk_assignment_status
        CHECK (status IN ('active', 'ended', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS fleet.driver_attendance (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id   BIGINT NOT NULL REFERENCES fleet.drivers(id)
                ON DELETE RESTRICT ON UPDATE CASCADE,
    attendance_date DATE NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'present',
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (driver_id, attendance_date),
    CONSTRAINT chk_attendance_status
        CHECK (status IN ('present', 'absent', 'late', 'leave', 'sick', 'other'))
);

CREATE TABLE IF NOT EXISTS fleet.dvir_reports (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id      BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id       BIGINT NOT NULL REFERENCES fleet.drivers(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    trip_id         BIGINT,
    inspection_type VARCHAR(30) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'submitted',
    checklist       JSONB NOT NULL DEFAULT '{}'::JSONB,
    defects         JSONB NOT NULL DEFAULT '[]'::JSONB,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     BIGINT REFERENCES auth.users(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_dvir_type CHECK (inspection_type IN ('pre_trip', 'post_trip', 'routine', 'other')),
    CONSTRAINT chk_dvir_status CHECK (status IN ('submitted', 'reviewed', 'requires_action', 'closed')),
    CONSTRAINT chk_dvir_json CHECK (
        jsonb_typeof(checklist) = 'object' AND jsonb_typeof(defects) = 'array'
    )
);

CREATE TRIGGER trg_fleet_depots_updated_at
    BEFORE UPDATE ON fleet.depots
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE TRIGGER trg_fleet_vehicles_updated_at
    BEFORE UPDATE ON fleet.vehicles
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE TRIGGER trg_fleet_drivers_updated_at
    BEFORE UPDATE ON fleet.drivers
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE TRIGGER trg_fleet_assignments_updated_at
    BEFORE UPDATE ON fleet.driver_vehicle_assignments
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE TRIGGER trg_fleet_attendance_updated_at
    BEFORE UPDATE ON fleet.driver_attendance
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE TRIGGER trg_fleet_dvir_updated_at
    BEFORE UPDATE ON fleet.dvir_reports
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- Temporary/primary assignments: at most one current vehicle per driver
-- and one current primary driver per vehicle.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fleet_active_driver_primary
    ON fleet.driver_vehicle_assignments(driver_id)
    WHERE status = 'active' AND assignment_type = 'primary' AND assigned_until IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_fleet_active_vehicle_primary
    ON fleet.driver_vehicle_assignments(vehicle_id)
    WHERE status = 'active' AND assignment_type = 'primary' AND assigned_until IS NULL;

-- +migrate Down

DROP TABLE IF EXISTS fleet.dvir_reports;
DROP TABLE IF EXISTS fleet.driver_attendance;
DROP TABLE IF EXISTS fleet.driver_vehicle_assignments;
DROP TABLE IF EXISTS fleet.drivers;
DROP TABLE IF EXISTS fleet.vehicles;
DROP TABLE IF EXISTS fleet.depots;
DROP SCHEMA IF EXISTS fleet;
