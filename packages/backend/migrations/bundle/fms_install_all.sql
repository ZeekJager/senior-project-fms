-- ===== 001_core_identity.sql =====
CREATE SCHEMA IF NOT EXISTS shared;
CREATE SCHEMA IF NOT EXISTS auth;

REVOKE CREATE ON SCHEMA shared FROM PUBLIC;
REVOKE CREATE ON SCHEMA auth   FROM PUBLIC;

CREATE OR REPLACE FUNCTION shared.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

-- Optimistic locking: every UPDATE bumps `version`, so a writer that
-- issues `UPDATE ... WHERE id = $1 AND version = $2` and gets 0 rows
-- knows someone else changed the row first. The app cannot forget to
-- increment it.
CREATE OR REPLACE FUNCTION shared.bump_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.version = OLD.version + 1;
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TYPE shared.vehicle_status AS ENUM
        ('active', 'inactive', 'maintenance', 'retired', 'decommissioned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE shared.vehicle_type AS ENUM
        ('car', 'suv', 'van', 'truck', 'bus', 'motorcycle', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE shared.fuel_type AS ENUM
        ('petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE shared.user_status AS ENUM
        ('active', 'inactive', 'suspended', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.roles (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(50)  NOT NULL UNIQUE,
    description TEXT,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth.permissions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        VARCHAR(100) NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE IF NOT EXISTS auth.role_permissions (
    role_id       BIGINT NOT NULL REFERENCES auth.roles(id)
                  ON DELETE CASCADE ON UPDATE CASCADE,
    permission_id BIGINT NOT NULL REFERENCES auth.permissions(id)
                  ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS auth.users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255) NOT NULL,
    phone         VARCHAR(50),
    -- Home depot. NULL for depot-unscoped users (admin, fleet_owner).
    -- FK to fleet.depots is added in 002, once that table exists.
    -- Also the driver's depot: fleet.drivers deliberately has no copy.
    depot_id      BIGINT,
    status        shared.user_status NOT NULL DEFAULT 'active',
    -- Soft-delete flag (DoD #6) derived from status, so the two can
    -- never disagree. Deactivate a user by changing status.
    is_active     BOOLEAN GENERATED ALWAYS AS (status = 'active') STORED,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_users_email_lower
    ON auth.users (LOWER(email));

CREATE TABLE IF NOT EXISTS auth.user_roles (
    user_id    BIGINT NOT NULL REFERENCES auth.users(id)
               ON DELETE CASCADE ON UPDATE CASCADE,
    role_id    BIGINT NOT NULL REFERENCES auth.roles(id)
               ON DELETE RESTRICT ON UPDATE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by BIGINT REFERENCES auth.users(id)
                ON DELETE SET NULL ON UPDATE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS auth.refresh_sessions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES auth.users(id)
                ON DELETE CASCADE ON UPDATE CASCADE,
    token_hash  VARCHAR(255) NOT NULL UNIQUE,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    CHECK (expires_at > issued_at),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE OR REPLACE TRIGGER trg_auth_roles_updated_at
    BEFORE UPDATE ON auth.roles
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_auth_users_updated_at
    BEFORE UPDATE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

INSERT INTO auth.roles (name, description) VALUES
    ('admin', 'Full system administration'),
    ('fleet_manager', 'Fleet-wide operational management'),
    ('dispatcher', 'Trip and command-center operations'),
    ('driver', 'Driver self-service and operational submissions'),
    ('technician', 'Maintenance and spare-parts operations'),
    ('depot_admin', 'Depot-level fleet administration'),
    ('finance_clerk', 'Fuel, cost and finance-related operations'),
    ('compliance_officer', 'Audit, compliance and incident oversight'),
    ('fleet_owner', 'Executive fleet visibility')
ON CONFLICT (name) DO NOTHING;

-- Permission codes are exactly the `resource:action` names in the
-- "Auth / permission" column of docs/api-contract.md, so the RBAC
-- middleware checks the contract's value verbatim. Two codes are added
-- by this schema and documented in the contract: audit:read (§5.2) and
-- trip:assign (§7.2, split from trip:execute so drivers can start/end
-- trips without being able to assign them).
INSERT INTO auth.permissions (code, description) VALUES
    ('users:read', 'Read user accounts'),
    ('users:write', 'Create and update user accounts'),
    ('roles:read', 'Read roles and their permissions'),
    ('audit:read', 'Read the audit log'),
    ('depot:read', 'Read depots'),
    ('depot:write', 'Create and update depots'),
    ('vehicle:read', 'Read vehicles'),
    ('vehicle:write', 'Create and update vehicles'),
    ('vehicle:delete', 'Retire vehicles'),
    ('driver:read', 'Read drivers'),
    ('driver:write', 'Create and update drivers'),
    ('driver:delete', 'Retire drivers'),
    ('assignment:read', 'Read driver/vehicle assignments'),
    ('assignment:write', 'Create driver/vehicle assignments'),
    ('attendance:read', 'Read driver attendance'),
    ('attendance:write', 'Record and update driver attendance'),
    ('dvir:read', 'Read driver vehicle inspection reports'),
    ('dvir:write', 'Submit driver vehicle inspection reports'),
    ('route:read', 'Read routes'),
    ('route:write', 'Create and update routes'),
    ('trip:read', 'Read trips'),
    ('trip:write', 'Create and update trips'),
    ('trip:assign', 'Assign a driver and vehicle to a trip'),
    ('trip:execute', 'Start, end and transition trips and stops'),
    ('document:read', 'Read document metadata and signed URLs'),
    ('document:write', 'Upload documents'),
    ('document:delete', 'Retire documents'),
    ('fuel:read', 'Read fuel logs and summaries'),
    ('fuel:write', 'Record fuel events'),
    ('fuel-anomaly:read', 'Read fuel anomalies'),
    ('fuel-anomaly:write', 'Resolve fuel anomalies'),
    ('maintenance:read', 'Read maintenance records'),
    ('maintenance:write', 'Create and update maintenance records'),
    ('maintenance:execute', 'Complete maintenance work'),
    ('inventory:read', 'Read spare-parts inventory'),
    ('inventory:write', 'Adjust stock and record inventory movements'),
    ('prediction:read', 'Read predictive-maintenance results'),
    ('tracking:read', 'Read live and historical vehicle tracking'),
    ('tracking:ingest', 'Submit GPS telemetry (device/service credentials)'),
    ('command:read', 'Read the command-center overview'),
    ('alert:read', 'Read alerts'),
    ('alert:ack', 'Acknowledge alerts'),
    ('alert:resolve', 'Resolve alerts'),
    ('notification:read', 'Read notifications'),
    ('incident:read', 'Read incidents'),
    ('incident:write', 'Report and update incidents'),
    ('ev:read', 'Read EV battery and charging data'),
    ('ev:write', 'Record EV battery and charging data'),
    ('analytics:read', 'Read analytics and reporting'),
    ('integration:read', 'Read integration provider status'),
    ('integration:execute', 'Trigger integration provider syncs')
ON CONFLICT (code) DO NOTHING;

-- Admin receives every permission; fleet_manager every permission except
-- user administration and raw telemetry ingestion.
INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
CROSS JOIN auth.permissions p
WHERE r.name = 'admin'
   OR (r.name = 'fleet_manager' AND p.code NOT IN ('users:write', 'tracking:ingest'))
ON CONFLICT DO NOTHING;

-- Least-privilege grants for the remaining roles. tracking:ingest is
-- reserved for device/provider service credentials, so no human role
-- other than admin holds it.
DROP TABLE IF EXISTS seed_role_grants;
CREATE TEMP TABLE seed_role_grants (role_name TEXT NOT NULL, codes TEXT[] NOT NULL);

INSERT INTO seed_role_grants (role_name, codes) VALUES
    ('dispatcher', ARRAY[
        'depot:read', 'vehicle:read', 'driver:read', 'assignment:read',
        'assignment:write', 'attendance:read', 'route:read', 'route:write',
        'trip:read', 'trip:write', 'trip:assign', 'trip:execute',
        'tracking:read', 'command:read', 'alert:read', 'alert:ack',
        'alert:resolve', 'incident:read', 'document:read',
        'notification:read', 'analytics:read']),
    ('driver', ARRAY[
        'vehicle:read', 'route:read', 'trip:read', 'trip:execute',
        'attendance:read', 'attendance:write', 'dvir:read', 'dvir:write',
        'fuel:read', 'fuel:write', 'incident:read', 'incident:write',
        'document:read', 'document:write', 'notification:read']),
    ('technician', ARRAY[
        'depot:read', 'vehicle:read', 'dvir:read', 'dvir:write',
        'maintenance:read', 'maintenance:write', 'maintenance:execute',
        'inventory:read', 'inventory:write', 'prediction:read',
        'incident:read', 'incident:write', 'alert:read', 'document:read',
        'document:write', 'notification:read']),
    ('depot_admin', ARRAY[
        'depot:read', 'vehicle:read', 'vehicle:write', 'vehicle:delete',
        'driver:read', 'driver:write', 'driver:delete', 'assignment:read',
        'assignment:write', 'attendance:read', 'attendance:write',
        'route:read', 'route:write', 'trip:read', 'fuel:read', 'fuel:write',
        'fuel-anomaly:read', 'maintenance:read', 'maintenance:write',
        'inventory:read', 'inventory:write', 'prediction:read',
        'tracking:read', 'command:read', 'alert:read', 'alert:ack',
        'ev:read', 'ev:write', 'dvir:read', 'dvir:write', 'incident:read',
        'incident:write', 'document:read', 'document:write',
        'notification:read']),
    ('finance_clerk', ARRAY[
        'fuel:read', 'fuel:write', 'fuel-anomaly:read', 'fuel-anomaly:write',
        'analytics:read', 'notification:read']),
    ('compliance_officer', ARRAY[
        'users:read', 'roles:read', 'audit:read', 'depot:read',
        'vehicle:read', 'driver:read', 'assignment:read', 'attendance:read',
        'route:read', 'trip:read', 'fuel:read', 'fuel-anomaly:read',
        'maintenance:read', 'prediction:read', 'tracking:read', 'alert:read',
        'incident:read', 'dvir:read', 'document:read', 'analytics:read',
        'notification:read']),
    ('fleet_owner', ARRAY[
        'audit:read', 'depot:read', 'vehicle:read', 'driver:read',
        'route:read', 'trip:read', 'fuel:read', 'maintenance:read',
        'prediction:read', 'tracking:read', 'command:read', 'alert:read',
        'analytics:read', 'ev:read', 'notification:read']);

-- A misspelled code would otherwise be dropped silently by the join below.
DO $$
DECLARE
    unknown text;
BEGIN
    SELECT string_agg(DISTINCT c, ', ') INTO unknown
    FROM seed_role_grants g
    CROSS JOIN LATERAL unnest(g.codes) AS c
    WHERE NOT EXISTS (SELECT 1 FROM auth.permissions p WHERE p.code = c);

    IF unknown IS NOT NULL THEN
        RAISE EXCEPTION 'unknown permission code(s) in role seed: %', unknown;
    END IF;
END $$;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM seed_role_grants g
CROSS JOIN LATERAL unnest(g.codes) AS c
JOIN auth.roles r ON r.name = g.role_name
JOIN auth.permissions p ON p.code = c
ON CONFLICT DO NOTHING;

DROP TABLE seed_role_grants;

-- ===== 002_fleet.sql =====
CREATE SCHEMA IF NOT EXISTS fleet;
REVOKE CREATE ON SCHEMA fleet FROM PUBLIC;

CREATE TABLE IF NOT EXISTS fleet.depots (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    -- Display location (POST /depots accepts name + location). The
    -- structured address fields below are optional refinements.
    location    VARCHAR(255) NOT NULL,
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
    -- "Needs maintenance, do not dispatch" (set by POST /maintenance,
    -- cleared on completion; assignment fails CONFLICT_VEHICLE_FLAGGED).
    -- Distinct from status = 'maintenance', which means in the workshop.
    maintenance_flag     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Expected consumption, integer ml/km (no float in fuel paths). Basis
    -- for fuel reconciliation and fuel_variance flags. Not meaningful for
    -- EVs, so required for every other fuel type.
    fuel_efficiency_ml_per_km INTEGER
                         CHECK (fuel_efficiency_ml_per_km IS NULL OR fuel_efficiency_ml_per_km > 0),
    -- Latest AI health score snapshot (0-100) for list/dashboard reads;
    -- history lives in maintenance.maintenance_predictions.
    health_score         SMALLINT CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100),
    health_score_updated_at TIMESTAMPTZ,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_fleet_vehicle_registration UNIQUE (registration_number),
    CONSTRAINT uq_fleet_vehicle_vin UNIQUE (vin),
    CONSTRAINT chk_vehicle_fuel_efficiency
        CHECK (fuel_type = 'electric' OR fuel_efficiency_ml_per_km IS NOT NULL),
    CONSTRAINT chk_vehicle_health_score_time
        CHECK ((health_score IS NULL) = (health_score_updated_at IS NULL))
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
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    logged_by   BIGINT NOT NULL REFERENCES auth.users(id)
                ON DELETE RESTRICT ON UPDATE CASCADE,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (driver_id, attendance_date),
    CONSTRAINT chk_attendance_status
        CHECK (status IN ('present', 'absent', 'on_leave', 'late', 'sick', 'other'))
);

CREATE TABLE IF NOT EXISTS fleet.dvir_reports (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id      BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id       BIGINT NOT NULL REFERENCES fleet.drivers(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    trip_id         BIGINT,  -- FK fk_dvir_trip added in 003, once trip.trips exists
    inspection_type VARCHAR(30) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'submitted',
    checklist       JSONB NOT NULL DEFAULT '{}'::JSONB,
    defects         JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Driver's own "issues found" answer (POST /dvir issuesFound). May be
    -- TRUE with no structured defects, but listed defects force TRUE.
    issues_found    BOOLEAN NOT NULL DEFAULT FALSE,
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
    ),
    CONSTRAINT chk_dvir_issues_found
        CHECK (issues_found OR jsonb_array_length(defects) = 0)
);

CREATE OR REPLACE TRIGGER trg_fleet_depots_updated_at
    BEFORE UPDATE ON fleet.depots
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fleet_vehicles_updated_at
    BEFORE UPDATE ON fleet.vehicles
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fleet_drivers_updated_at
    BEFORE UPDATE ON fleet.drivers
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fleet_assignments_updated_at
    BEFORE UPDATE ON fleet.driver_vehicle_assignments
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fleet_attendance_updated_at
    BEFORE UPDATE ON fleet.driver_attendance
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fleet_dvir_updated_at
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

-- auth.users.depot_id is created in 001, before fleet.depots exists.
DO $$ BEGIN
    ALTER TABLE auth.users
        ADD CONSTRAINT fk_users_depot
        FOREIGN KEY (depot_id) REFERENCES fleet.depots(id)
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ===== 003_trip_route.sql =====
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

-- ===== 004_fuel.sql =====
CREATE SCHEMA IF NOT EXISTS fuel;
REVOKE CREATE ON SCHEMA fuel FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE fuel.fuel_source AS ENUM
        ('pump', 'fuel_card', 'bulk', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE fuel.anomaly_status AS ENUM
        ('open', 'reviewed', 'dismissed', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fuel.fuel_logs (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id            BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                          ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id             BIGINT REFERENCES fleet.drivers(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    trip_id               BIGINT REFERENCES trip.trips(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    fuel_type             shared.fuel_type NOT NULL,
    quantity_ml           BIGINT NOT NULL CHECK (quantity_ml > 0),
    unit_price_cents      INTEGER CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
    total_cost_cents      INTEGER NOT NULL CHECK (total_cost_cents >= 0),
    odometer_km           NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    latitude              NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude             NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    station_name          VARCHAR(255),
    external_reference    VARCHAR(255),
    source                fuel.fuel_source NOT NULL DEFAULT 'manual',
    recorded_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fuel.fuel_anomalies (
    id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fuel_log_id                BIGINT NOT NULL REFERENCES fuel.fuel_logs(id)
                               ON DELETE CASCADE ON UPDATE CASCADE,
    vehicle_id                 BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                               ON DELETE RESTRICT ON UPDATE CASCADE,
    anomaly_type               VARCHAR(50) NOT NULL,
    expected_consumption_ml_100km NUMERIC(12,3),
    actual_consumption_ml_100km   NUMERIC(12,3),
    deviation_percentage       NUMERIC(7,2),
    severity                   VARCHAR(20) NOT NULL DEFAULT 'medium',
    status                     fuel.anomaly_status NOT NULL DEFAULT 'open',
    detected_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by                BIGINT REFERENCES auth.users(id)
                               ON DELETE SET NULL ON UPDATE CASCADE,
    reviewed_at                TIMESTAMPTZ,
    notes                      TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_fuel_anomaly_severity
        CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE OR REPLACE TRIGGER trg_fuel_logs_updated_at
    BEFORE UPDATE ON fuel.fuel_logs
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fuel_anomalies_updated_at
    BEFORE UPDATE ON fuel.fuel_anomalies
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ===== 005_maintenance.sql =====
CREATE SCHEMA IF NOT EXISTS maintenance;
REVOKE CREATE ON SCHEMA maintenance FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE maintenance.maintenance_status AS ENUM
        ('scheduled', 'open', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.maintenance_type AS ENUM
        ('preventive', 'corrective', 'predictive', 'inspection', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.inventory_parts (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    depot_id           BIGINT REFERENCES fleet.depots(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    part_number        VARCHAR(100) NOT NULL UNIQUE,
    name               VARCHAR(255) NOT NULL,
    description        TEXT,
    unit_cost_cents    INTEGER CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
    stock_quantity     INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    reorder_threshold  INTEGER NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance.maintenance_records (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    technician_id      BIGINT REFERENCES auth.users(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    maintenance_type   maintenance.maintenance_type NOT NULL DEFAULT 'other',
    description        TEXT,
    status             maintenance.maintenance_status NOT NULL DEFAULT 'open',
    priority           VARCHAR(20) NOT NULL DEFAULT 'normal',
    scheduled_at       TIMESTAMPTZ,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    odometer_km        NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    labor_hours        NUMERIC(8,2) CHECK (labor_hours IS NULL OR labor_hours >= 0),
    total_cost_cents   INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_cents >= 0),
    workshop           VARCHAR(255),
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_maintenance_priority
        CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    CONSTRAINT chk_maintenance_times
        CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS maintenance.maintenance_parts (
    maintenance_record_id BIGINT NOT NULL REFERENCES maintenance.maintenance_records(id)
                          ON DELETE CASCADE ON UPDATE CASCADE,
    inventory_part_id     BIGINT NOT NULL REFERENCES maintenance.inventory_parts(id)
                          ON DELETE RESTRICT ON UPDATE CASCADE,
    quantity              INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost_cents       INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (maintenance_record_id, inventory_part_id)
);

CREATE TABLE IF NOT EXISTS maintenance.inventory_movements (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_part_id   BIGINT NOT NULL REFERENCES maintenance.inventory_parts(id)
                        ON DELETE RESTRICT ON UPDATE CASCADE,
    depot_id            BIGINT REFERENCES fleet.depots(id)
                        ON DELETE SET NULL ON UPDATE CASCADE,
    movement_type       VARCHAR(30) NOT NULL,
    quantity_delta      INTEGER NOT NULL,
    reference_type      VARCHAR(50),
    reference_id        BIGINT,
    performed_by        BIGINT REFERENCES auth.users(id)
                        ON DELETE SET NULL ON UPDATE CASCADE,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes               TEXT,
    CONSTRAINT chk_inventory_movement_type
        CHECK (movement_type IN ('purchase', 'consumption', 'adjustment', 'transfer_in', 'transfer_out', 'return')),
    CONSTRAINT chk_inventory_quantity_delta CHECK (quantity_delta <> 0)
);

CREATE TABLE IF NOT EXISTS maintenance.maintenance_predictions (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id              BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                            ON DELETE RESTRICT ON UPDATE CASCADE,
    model_name              VARCHAR(100) NOT NULL,
    model_version           VARCHAR(100) NOT NULL,
    prediction_type         VARCHAR(100) NOT NULL,
    risk_score              NUMERIC(6,5) NOT NULL CHECK (risk_score BETWEEN 0 AND 1),
    predicted_failure_type  VARCHAR(255),
    prediction_horizon_days INTEGER CHECK (prediction_horizon_days IS NULL OR prediction_horizon_days >= 0),
    confidence              NUMERIC(6,5) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    feature_snapshot        JSONB,
    generated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_prediction_status
        CHECK (status IN ('active', 'superseded', 'dismissed')),
    CONSTRAINT chk_prediction_features
        CHECK (feature_snapshot IS NULL OR jsonb_typeof(feature_snapshot) = 'object')
);

CREATE OR REPLACE TRIGGER trg_maintenance_inventory_parts_updated_at
    BEFORE UPDATE ON maintenance.inventory_parts
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_maintenance_records_updated_at
    BEFORE UPDATE ON maintenance.maintenance_records
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_maintenance_predictions_updated_at
    BEFORE UPDATE ON maintenance.maintenance_predictions
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ===== 006_integration.sql =====
CREATE SCHEMA IF NOT EXISTS integration;
REVOKE CREATE ON SCHEMA integration FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE integration.provider_type AS ENUM
        ('telematics', 'notification', 'mapping', 'traffic', 'weather', 'ev_charging', 'fuel_card', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS integration.external_providers (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    provider_type   integration.provider_type NOT NULL,
    base_url        TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    configuration   JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_provider_config CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE TABLE IF NOT EXISTS integration.gps_devices (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id       BIGINT REFERENCES integration.external_providers(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    vehicle_id        BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                      ON DELETE RESTRICT ON UPDATE CASCADE,
    device_identifier VARCHAR(255) NOT NULL,
    device_model      VARCHAR(255),
    installed_at      TIMESTAMPTZ,
    removed_at        TIMESTAMPTZ,
    status            VARCHAR(20) NOT NULL DEFAULT 'active',
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (device_identifier),
    CONSTRAINT chk_gps_device_status
        CHECK (status IN ('active', 'inactive', 'faulty', 'removed')),
    CONSTRAINT chk_gps_device_dates
        CHECK (removed_at IS NULL OR installed_at IS NULL OR removed_at >= installed_at)
);

CREATE TABLE IF NOT EXISTS integration.sync_logs (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id        BIGINT REFERENCES integration.external_providers(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    integration_name   VARCHAR(100) NOT NULL,
    direction          VARCHAR(20) NOT NULL,
    status             VARCHAR(20) NOT NULL,
    external_reference VARCHAR(255),
    request_id         VARCHAR(255),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at       TIMESTAMPTZ,
    error_message      TEXT,
    metadata           JSONB NOT NULL DEFAULT '{}'::JSONB,
    CONSTRAINT chk_sync_direction CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT chk_sync_status CHECK (status IN ('started', 'succeeded', 'failed', 'partial')),
    CONSTRAINT chk_sync_metadata CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS integration.fuel_card_transactions (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id           BIGINT REFERENCES integration.external_providers(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    vehicle_id            BIGINT REFERENCES fleet.vehicles(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    driver_id             BIGINT REFERENCES fleet.drivers(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    external_transaction_id VARCHAR(255) NOT NULL,
    transaction_time      TIMESTAMPTZ NOT NULL,
    quantity_ml           BIGINT CHECK (quantity_ml IS NULL OR quantity_ml > 0),
    total_cost_cents      INTEGER CHECK (total_cost_cents IS NULL OR total_cost_cents >= 0),
    station_name          VARCHAR(255),
    raw_payload           JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT chk_fuel_card_payload CHECK (jsonb_typeof(raw_payload) = 'object')
);

CREATE OR REPLACE TRIGGER trg_integration_providers_updated_at
    BEFORE UPDATE ON integration.external_providers
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_integration_gps_devices_updated_at
    BEFORE UPDATE ON integration.gps_devices
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ===== 007_tracking.sql =====
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
    speed_kmh        SMALLINT NOT NULL CHECK (speed_kmh >= 0),
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
    -- Integer km/h (FMS-02 card): speeding is "> 80 km/h", so decimals
    -- add nothing but rounding ambiguity.
    speed_kmh        SMALLINT NOT NULL CHECK (speed_kmh >= 0),
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
    -- When the condition itself ended (vehicle back under the limit,
    -- idling stopped). NULL while ongoing. Separate from review status.
    resolved_at        TIMESTAMPTZ,
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
        CHECK (jsonb_typeof(details) = 'object'),
    CONSTRAINT chk_telemetry_resolved_time
        CHECK (resolved_at IS NULL OR resolved_at >= observed_at)
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

-- ===== 008_alerts_incidents.sql =====
CREATE SCHEMA IF NOT EXISTS alert;
REVOKE CREATE ON SCHEMA alert FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE alert.alert_severity AS ENUM
        ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert.alert_status AS ENUM
        ('open', 'acknowledged', 'resolved', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert.notification_channel AS ENUM
        ('in_app', 'push', 'sms', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert.notification_status AS ENUM
        ('queued', 'sent', 'delivered', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS alert.alerts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id        BIGINT REFERENCES fleet.vehicles(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    driver_id         BIGINT REFERENCES fleet.drivers(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    alert_type        VARCHAR(100) NOT NULL,
    severity          alert.alert_severity NOT NULL DEFAULT 'medium',
    source_module     VARCHAR(50) NOT NULL,
    source_event_type VARCHAR(100),
    source_record_id  BIGINT,
    title             VARCHAR(255) NOT NULL,
    description       TEXT,
    status            alert.alert_status NOT NULL DEFAULT 'open',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at   TIMESTAMPTZ,
    resolved_at       TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_alert_ack_time
        CHECK (acknowledged_at IS NULL OR acknowledged_at >= created_at),
    CONSTRAINT chk_alert_resolve_time
        CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE TABLE IF NOT EXISTS alert.alert_acknowledgements (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id        BIGINT NOT NULL REFERENCES alert.alerts(id)
                    ON DELETE CASCADE ON UPDATE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES auth.users(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    action          VARCHAR(30) NOT NULL,
    comment         TEXT,
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_alert_ack_action
        CHECK (action IN ('acknowledge', 'resolve', 'dismiss', 'comment'))
);

-- One row per recipient per channel. Doubles as the in-app inbox (S-17):
-- an 'in_app' row is the inbox entry and read_at marks it read. Not every
-- notification comes from an alert (e.g. "trip assigned"), so alert_id
-- is optional and the content lives on the row itself.
CREATE TABLE IF NOT EXISTS alert.notifications (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id             BIGINT REFERENCES alert.alerts(id)
                         ON DELETE CASCADE ON UPDATE CASCADE,
    recipient_user_id    BIGINT NOT NULL REFERENCES auth.users(id)
                         ON DELETE RESTRICT ON UPDATE CASCADE,
    provider_id          BIGINT REFERENCES integration.external_providers(id)
                         ON DELETE SET NULL ON UPDATE CASCADE,
    notification_type    VARCHAR(50) NOT NULL,
    title                VARCHAR(255) NOT NULL,
    message              TEXT NOT NULL,
    read_at              TIMESTAMPTZ,
    channel              alert.notification_channel NOT NULL,
    status               alert.notification_status NOT NULL DEFAULT 'queued',
    provider_message_id  VARCHAR(255),
    delivery_attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
    queued_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at              TIMESTAMPTZ,
    delivered_at         TIMESTAMPTZ,
    failed_at            TIMESTAMPTZ,
    failure_reason       TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_notification_read_in_app
        CHECK (read_at IS NULL OR channel = 'in_app')
);

CREATE TABLE IF NOT EXISTS alert.incident_reports (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id      BIGINT REFERENCES fleet.vehicles(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    driver_id       BIGINT REFERENCES fleet.drivers(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    trip_id         BIGINT REFERENCES trip.trips(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    reported_by     BIGINT NOT NULL REFERENCES auth.users(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    incident_type   VARCHAR(100) NOT NULL,
    severity        alert.alert_severity NOT NULL DEFAULT 'medium',
    description     TEXT NOT NULL,
    latitude        NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude       NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    occurred_at     TIMESTAMPTZ NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'open',
    attachments     JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_incident_status
        CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
    CONSTRAINT chk_incident_attachments
        CHECK (jsonb_typeof(attachments) = 'array')
);

CREATE OR REPLACE TRIGGER trg_alert_alerts_updated_at
    BEFORE UPDATE ON alert.alerts
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_alert_notifications_updated_at
    BEFORE UPDATE ON alert.notifications
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_alert_incidents_updated_at
    BEFORE UPDATE ON alert.incident_reports
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ===== 009_ev.sql =====
CREATE SCHEMA IF NOT EXISTS ev;
REVOKE CREATE ON SCHEMA ev FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE ev.charging_status AS ENUM
        ('planned', 'in_progress', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ev.charging_stations (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id          BIGINT REFERENCES integration.external_providers(id)
                         ON DELETE SET NULL ON UPDATE CASCADE,
    external_station_id  VARCHAR(255) NOT NULL,
    name                 VARCHAR(255) NOT NULL,
    latitude             NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude            NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    connector_type       VARCHAR(50),
    power_kw             NUMERIC(10,2) CHECK (power_kw IS NULL OR power_kw >= 0),
    status               VARCHAR(20) NOT NULL DEFAULT 'available',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, external_station_id)
);

CREATE TABLE IF NOT EXISTS ev.ev_battery_logs (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    state_of_charge    NUMERIC(5,2) NOT NULL CHECK (state_of_charge BETWEEN 0 AND 100),
    battery_health     NUMERIC(5,2) CHECK (battery_health IS NULL OR battery_health BETWEEN 0 AND 100),
    battery_temperature_c NUMERIC(8,2),
    voltage_v          NUMERIC(10,3),
    current_a          NUMERIC(10,3),
    estimated_range_km NUMERIC(10,2) CHECK (estimated_range_km IS NULL OR estimated_range_km >= 0),
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ev.charging_sessions (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id            BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                          ON DELETE RESTRICT ON UPDATE CASCADE,
    station_id            BIGINT REFERENCES ev.charging_stations(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    external_session_id   VARCHAR(255),
    started_at             TIMESTAMPTZ,
    ended_at               TIMESTAMPTZ,
    energy_kwh             NUMERIC(12,3) CHECK (energy_kwh IS NULL OR energy_kwh >= 0),
    cost_cents             INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
    start_soc              NUMERIC(5,2) CHECK (start_soc IS NULL OR start_soc BETWEEN 0 AND 100),
    end_soc                NUMERIC(5,2) CHECK (end_soc IS NULL OR end_soc BETWEEN 0 AND 100),
    status                 ev.charging_status NOT NULL DEFAULT 'planned',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_charging_times
        CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    CONSTRAINT uq_charging_external_session UNIQUE (external_session_id)
);

CREATE OR REPLACE TRIGGER trg_ev_stations_updated_at
    BEFORE UPDATE ON ev.charging_stations
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_ev_sessions_updated_at
    BEFORE UPDATE ON ev.charging_sessions
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ===== 010_audit.sql =====
CREATE SCHEMA IF NOT EXISTS audit;
REVOKE CREATE ON SCHEMA audit FROM PUBLIC;

CREATE TABLE IF NOT EXISTS audit.audit_logs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Plain FK (no SET NULL / CASCADE): either action would have to UPDATE
    -- audit rows, which the trigger forbids. Users are deactivated via
    -- auth.users.status, never deleted.
    user_id       BIGINT REFERENCES auth.users(id),
    action        VARCHAR(100) NOT NULL,
    entity_type   VARCHAR(100),
    entity_id     BIGINT,
    -- Same uuid the API returns as `correlationId` in error bodies, so a
    -- reported error can be traced to the mutations of that request.
    correlation_id UUID,
    ip_address    INET,
    old_values    JSONB,
    new_values    JSONB,
    details       JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_audit_details CHECK (jsonb_typeof(details) = 'object')
);

CREATE OR REPLACE FUNCTION audit.prevent_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit.audit_logs is append-only; % is not permitted', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER trg_audit_prevent_update_delete
    BEFORE UPDATE OR DELETE ON audit.audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit.prevent_audit_mutation();

CREATE OR REPLACE TRIGGER trg_audit_prevent_truncate
    BEFORE TRUNCATE ON audit.audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit.prevent_audit_mutation();

-- ===== 011_indexes_and_analytics.sql =====
CREATE SCHEMA IF NOT EXISTS analytics;
REVOKE CREATE ON SCHEMA analytics FROM PUBLIC;

-- Precomputed per-vehicle KPIs for the analytics dashboard (S-18,
-- GET /analytics/utilisation). Written by a scheduled job as an UPSERT
-- on (vehicle_id, period_type, period_start); safe to truncate and
-- rebuild. Integer percentages and integer cents (no float).
CREATE TABLE IF NOT EXISTS analytics.analytics_cache (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id          BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                        ON DELETE RESTRICT ON UPDATE CASCADE,
    period_type         VARCHAR(10) NOT NULL,
    period_start        DATE NOT NULL,
    utilisation_pct     SMALLINT NOT NULL CHECK (utilisation_pct BETWEEN 0 AND 100),
    cost_per_km_cents   INTEGER NOT NULL CHECK (cost_per_km_cents >= 0),
    driver_on_time_pct  SMALLINT CHECK (driver_on_time_pct IS NULL OR driver_on_time_pct BETWEEN 0 AND 100),
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_analytics_period_type
        CHECK (period_type IN ('day', 'week', 'month')),
    CONSTRAINT uq_analytics_cache_period
        UNIQUE (vehicle_id, period_type, period_start)
);

CREATE OR REPLACE TRIGGER trg_analytics_cache_updated_at
    BEFORE UPDATE ON analytics.analytics_cache
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ----------------------------
-- Auth / RBAC
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_auth_user_roles_role
    ON auth.user_roles(role_id, user_id);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_user
    ON auth.refresh_sessions(user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_active
    ON auth.refresh_sessions(user_id, expires_at)
    WHERE revoked_at IS NULL;

-- Depot scoping; also serves GET /drivers?depotId= via the user join.
CREATE INDEX IF NOT EXISTS idx_auth_users_depot
    ON auth.users(depot_id);

-- ----------------------------
-- Fleet
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_depot_status
    ON fleet.vehicles(depot_id, status);

-- GET /vehicles?maintenanceFlag=true
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_flagged
    ON fleet.vehicles(depot_id)
    WHERE maintenance_flag;

CREATE INDEX IF NOT EXISTS idx_fleet_drivers_active
    ON fleet.drivers(is_active);

CREATE INDEX IF NOT EXISTS idx_fleet_assignments_driver_dates
    ON fleet.driver_vehicle_assignments(driver_id, assigned_from DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_assignments_vehicle_dates
    ON fleet.driver_vehicle_assignments(vehicle_id, assigned_from DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_attendance_date
    ON fleet.driver_attendance(attendance_date, driver_id);

CREATE INDEX IF NOT EXISTS idx_fleet_dvir_vehicle_time
    ON fleet.dvir_reports(vehicle_id, submitted_at DESC);

-- ----------------------------
-- Trips
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_trip_trips_vehicle_status
    ON trip.trips(vehicle_id, status);

CREATE INDEX IF NOT EXISTS idx_trip_trips_driver_status
    ON trip.trips(driver_id, status);

CREATE INDEX IF NOT EXISTS idx_trip_trips_schedule
    ON trip.trips(scheduled_start, status);

CREATE INDEX IF NOT EXISTS idx_trip_trip_stops_trip_status
    ON trip.trip_stops(trip_id, status, sequence_number);

-- ----------------------------
-- Fuel
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_fuel_logs_vehicle_time
    ON fuel.fuel_logs(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_driver_time
    ON fuel.fuel_logs(driver_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_trip
    ON fuel.fuel_logs(trip_id);

CREATE INDEX IF NOT EXISTS idx_fuel_anomalies_vehicle_status
    ON fuel.fuel_anomalies(vehicle_id, status, detected_at DESC);

-- ----------------------------
-- Maintenance
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_maintenance_records_vehicle_status
    ON maintenance.maintenance_records(vehicle_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_maintenance_records_technician
    ON maintenance.maintenance_records(technician_id, status);

CREATE INDEX IF NOT EXISTS idx_maintenance_parts_part
    ON maintenance.maintenance_parts(inventory_part_id);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_part_time
    ON maintenance.inventory_movements(inventory_part_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_predictions_vehicle_time
    ON maintenance.maintenance_predictions(vehicle_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_predictions_active
    ON maintenance.maintenance_predictions(vehicle_id, generated_at DESC)
    WHERE status = 'active';

-- ----------------------------
-- Integration
-- ----------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_active_gps_device_vehicle
    ON integration.gps_devices(vehicle_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_provider_time
    ON integration.sync_logs(provider_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_status
    ON integration.sync_logs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fuel_card_transactions_vehicle_time
    ON integration.fuel_card_transactions(vehicle_id, transaction_time DESC);

-- ----------------------------
-- Tracking
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_tracking_gps_pings_vehicle_time
    ON tracking.gps_pings(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_gps_pings_trip_time
    ON tracking.gps_pings(trip_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_current_location_updated
    ON tracking.vehicle_current_location(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_flags_vehicle_time
    ON tracking.telemetry_flags(vehicle_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_flags_open
    ON tracking.telemetry_flags(vehicle_id, observed_at DESC)
    WHERE status = 'open';

-- ----------------------------
-- Alerts / Incidents
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_status_time
    ON alert.alerts(vehicle_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_open_severity
    ON alert.alerts(severity DESC, created_at DESC)
    WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_alert_notifications_pending
    ON alert.notifications(status, queued_at)
    WHERE status IN ('queued', 'sent');

CREATE INDEX IF NOT EXISTS idx_alert_notifications_recipient
    ON alert.notifications(recipient_user_id, queued_at DESC);

-- Notification inbox badge / unread list (S-17).
CREATE INDEX IF NOT EXISTS idx_alert_notifications_unread
    ON alert.notifications(recipient_user_id, queued_at DESC)
    WHERE channel = 'in_app' AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_incidents_vehicle_time
    ON alert.incident_reports(vehicle_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_status
    ON alert.incident_reports(status, occurred_at DESC);

-- ----------------------------
-- EV
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_ev_battery_vehicle_time
    ON ev.ev_battery_logs(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ev_sessions_vehicle_time
    ON ev.charging_sessions(vehicle_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ev_stations_location
    ON ev.charging_stations(latitude, longitude);

-- ----------------------------
-- Audit
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_audit_user_time
    ON audit.audit_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_entity_time
    ON audit.audit_logs(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_correlation
    ON audit.audit_logs(correlation_id);

-- =====================================================================
-- Analytics views
-- =====================================================================

CREATE OR REPLACE VIEW analytics.vehicle_current_status AS
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

CREATE OR REPLACE VIEW analytics.fuel_efficiency_summary AS
SELECT
    f.vehicle_id,
    COUNT(*) AS fuel_event_count,
    SUM(f.quantity_ml) AS total_fuel_ml,
    SUM(f.total_cost_cents) AS total_fuel_cost_cents,
    MIN(f.recorded_at) AS first_recorded_at,
    MAX(f.recorded_at) AS last_recorded_at
FROM fuel.fuel_logs f
GROUP BY f.vehicle_id;

CREATE OR REPLACE VIEW analytics.maintenance_risk_summary AS
SELECT
    p.vehicle_id,
    p.prediction_type,
    p.risk_score,
    p.predicted_failure_type,
    p.model_name,
    p.model_version,
    p.generated_at
FROM maintenance.maintenance_predictions p
WHERE p.status = 'active'
  AND p.id = (
      SELECT p2.id
      FROM maintenance.maintenance_predictions p2
      WHERE p2.vehicle_id = p.vehicle_id
        AND p2.prediction_type = p.prediction_type
        AND p2.status = 'active'
      ORDER BY p2.generated_at DESC, p2.id DESC
      LIMIT 1
  );

CREATE OR REPLACE VIEW analytics.open_alert_summary AS
SELECT
    a.severity,
    COUNT(*) AS alert_count
FROM alert.alerts a
WHERE a.status IN ('open', 'acknowledged')
GROUP BY a.severity;

-- ===== 012_api_contract_alignment.sql =====
-- ---------------------------------------------------------------------
-- Public identifiers. Joins and foreign keys keep the BIGINT keys; the
-- API exposes only public_id, so identifiers are not sequential or
-- guessable. Resolve public_id -> id once at the API boundary.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'auth.users',
        'fleet.depots', 'fleet.vehicles', 'fleet.drivers',
        'fleet.driver_vehicle_assignments', 'fleet.driver_attendance',
        'fleet.dvir_reports',
        'trip.routes', 'trip.trips', 'trip.trip_stops',
        'fuel.fuel_logs', 'fuel.fuel_anomalies',
        'maintenance.maintenance_records', 'maintenance.inventory_parts',
        'maintenance.inventory_movements', 'maintenance.maintenance_predictions',
        'integration.external_providers', 'integration.sync_logs',
        'tracking.telemetry_flags',
        'alert.alerts', 'alert.notifications', 'alert.incident_reports',
        'ev.ev_battery_logs', 'ev.charging_stations', 'ev.charging_sessions']
    LOOP
        EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid()', t);
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (public_id)',
                       'ux_' || replace(t, '.', '_') || '_public_id', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- document.* — metadata for files held in object storage (§8). The file
-- itself never lives in PostgreSQL.
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS document;
REVOKE CREATE ON SCHEMA document FROM PUBLIC;

CREATE TABLE IF NOT EXISTS document.documents (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    -- What the file belongs to. Polymorphic (like alert.alerts.source_*),
    -- so it cannot be a single FK. The API must check the caller may read
    -- the owner before issuing a signed URL.
    owner_type        VARCHAR(50) NOT NULL,
    owner_id          BIGINT NOT NULL,
    document_type     VARCHAR(50) NOT NULL,
    -- Server-generated object key; never derived from the upload filename.
    storage_key       VARCHAR(512) NOT NULL UNIQUE,
    original_filename VARCHAR(255),
    content_type      VARCHAR(100) NOT NULL,
    size_bytes        INTEGER NOT NULL,
    sha256            CHAR(64) NOT NULL,
    uploaded_by       BIGINT NOT NULL REFERENCES auth.users(id),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    retain_until      DATE,
    -- Soft delete (DELETE /documents is a retirement, subject to retention).
    deleted_at        TIMESTAMPTZ,
    deleted_by        BIGINT REFERENCES auth.users(id),
    CONSTRAINT chk_document_owner_type CHECK (owner_type IN
        ('vehicle', 'driver', 'trip', 'maintenance_record', 'incident_report',
         'dvir_report', 'fuel_log')),
    CONSTRAINT chk_document_type CHECK (document_type IN
        ('registration', 'licence', 'insurance', 'maintenance_invoice',
         'inspection_evidence', 'incident_photo', 'dvir_attachment',
         'fuel_receipt', 'other')),
    CONSTRAINT chk_document_content_type CHECK (content_type IN
        ('image/jpeg', 'image/png', 'application/pdf')),
    CONSTRAINT chk_document_size CHECK (size_bytes BETWEEN 1 AND 10485760),
    CONSTRAINT chk_document_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_document_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_document_owner
    ON document.documents(owner_type, owner_id)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- api.idempotency_keys — Idempotency-Key store (§19). Usage:
--   INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING;
--   conflict + different request_hash -> 409 CONFLICT_IDEMPOTENCY_KEY_REUSED
--   conflict + status 'in_progress'   -> 409 (request still running)
--   conflict + status 'completed'     -> replay response_status/body
-- Webhooks de-duplicate on provider event keys instead (see below).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS api;
REVOKE CREATE ON SCHEMA api FROM PUBLIC;

CREATE TABLE IF NOT EXISTS api.idempotency_keys (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES auth.users(id),
    idempotency_key  VARCHAR(255) NOT NULL,
    request_method   VARCHAR(10) NOT NULL,
    request_path     VARCHAR(255) NOT NULL,
    request_hash     CHAR(64) NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    response_status  SMALLINT,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_idempotency_caller_key UNIQUE (user_id, idempotency_key),
    CONSTRAINT chk_idempotency_status CHECK (status IN ('in_progress', 'completed')),
    CONSTRAINT chk_idempotency_outcome
        CHECK ((status = 'completed') = (response_status IS NOT NULL)),
    CONSTRAINT chk_idempotency_expiry CHECK (expires_at > created_at)
);

-- Purge job: DELETE FROM api.idempotency_keys WHERE expires_at < now().
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON api.idempotency_keys(expires_at);

-- ---------------------------------------------------------------------
-- Trip overlap (§7.2, §17). The API checks first so it can answer with
-- the right 409 code, but only the database closes the race where two
-- concurrent assignments both pass that check. A violation raises
-- SQLSTATE 23P01; map ex_trip_driver_overlap -> CONFLICT_DRIVER_OVERLAP
-- and ex_trip_vehicle_overlap -> CONFLICT_VEHICLE_OVERLAP.
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
    ALTER TABLE trip.trips
        ADD CONSTRAINT ex_trip_driver_overlap
        EXCLUDE USING gist (
            driver_id WITH =,
            tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
        ) WHERE (status IN ('assigned', 'en_route'));
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE trip.trips
        ADD CONSTRAINT ex_trip_vehicle_overlap
        EXCLUDE USING gist (
            vehicle_id WITH =,
            tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
        ) WHERE (status IN ('assigned', 'en_route'));
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Telemetry retries (§15). One ping per vehicle per instant; webhook
-- handlers insert with ON CONFLICT DO NOTHING, so a provider retry is a
-- no-op. (Fuel-card and EV events already de-duplicate on their
-- provider ids.) The partition key is part of the constraint, as
-- PostgreSQL requires for partitioned tables.
-- ---------------------------------------------------------------------
DO $$ BEGIN
    ALTER TABLE tracking.gps_pings
        ADD CONSTRAINT uq_gps_ping_vehicle_time UNIQUE (vehicle_id, recorded_at);
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- POST /incidents sends vehicle_id, trip_id, description, severity only.
-- reported_by comes from the authenticated user; these cover the rest.
-- ---------------------------------------------------------------------
ALTER TABLE alert.incident_reports ALTER COLUMN occurred_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE alert.incident_reports ALTER COLUMN incident_type SET DEFAULT 'other';

-- ===== 013_app_grants.sql =====
DO $$
DECLARE
    s text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        RAISE NOTICE 'role fms_app not found; skipping application grants';
        RETURN;
    END IF;

    FOREACH s IN ARRAY ARRAY['shared', 'auth', 'fleet', 'trip', 'fuel',
                             'maintenance', 'integration', 'tracking',
                             'alert', 'ev', 'document', 'api']
    LOOP
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO fms_app', s);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO fms_app', s);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO fms_app', s);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fms_app', s);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO fms_app', s);
    END LOOP;

    -- Read-only reporting views.
    GRANT USAGE ON SCHEMA analytics TO fms_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO fms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO fms_app;
    GRANT INSERT, UPDATE, DELETE ON analytics.analytics_cache TO fms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA analytics TO fms_app;

    -- Append-only audit trail: no defaults, explicit table grants only.
    GRANT USAGE ON SCHEMA audit TO fms_app;
    GRANT SELECT, INSERT ON audit.audit_logs TO fms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO fms_app;
END $$;

-- ===== 014_auth_session_family.sql =====
-- Rows from before this migration each become their own family.
ALTER TABLE auth.refresh_sessions
    ADD COLUMN IF NOT EXISTS family_id UUID NOT NULL DEFAULT gen_random_uuid();
-- No default from here on: the application always sets the family.
ALTER TABLE auth.refresh_sessions
    ALTER COLUMN family_id DROP DEFAULT;

-- Revoking a family, and finding a family's live session.
CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_family
    ON auth.refresh_sessions(family_id)
    WHERE revoked_at IS NULL;

-- ===== 015_driver_license_categories.sql =====
ALTER TABLE fleet.drivers
    ADD COLUMN IF NOT EXISTS license_categories TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'fleet' AND table_name = 'drivers' AND column_name = 'license_category') THEN
        UPDATE fleet.drivers
           SET license_categories = ARRAY[upper(trim(license_category))]
         WHERE upper(trim(license_category)) IN
               ('AM','A1','A2','A','B1','B','BE','C1','C1E','C','CE','D1','D1E','D','DE');
        ALTER TABLE fleet.drivers DROP COLUMN license_category;
    END IF;
END $$;

ALTER TABLE fleet.drivers DROP CONSTRAINT IF EXISTS chk_driver_license_categories;
ALTER TABLE fleet.drivers
    ADD CONSTRAINT chk_driver_license_categories CHECK (
        license_categories <@ ARRAY['AM','A1','A2','A','B1','B','BE','C1','C1E','C','CE','D1','D1E','D','DE']::TEXT[]
    );

-- ===== 016_fleet_row_versions.sql =====
ALTER TABLE fleet.vehicles ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet.drivers  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_fleet_vehicles_version
    BEFORE UPDATE ON fleet.vehicles
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE OR REPLACE TRIGGER trg_fleet_drivers_version
    BEFORE UPDATE ON fleet.drivers
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

-- ===== 017_fleet_driver_accounts.sql =====
CREATE TABLE IF NOT EXISTS fleet.driver_accounts (
    user_id         BIGINT PRIMARY KEY REFERENCES auth.users(id)
                    ON DELETE CASCADE ON UPDATE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    depot_id        BIGINT REFERENCES fleet.depots(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    account_status  shared.user_status NOT NULL,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fleet_driver_accounts_depot
    ON fleet.driver_accounts(depot_id);

INSERT INTO fleet.driver_accounts (user_id, full_name, email, depot_id, account_status)
SELECT u.id, u.full_name, u.email, u.depot_id, u.status
  FROM fleet.drivers d
  JOIN auth.users u ON u.id = d.user_id
ON CONFLICT (user_id) DO NOTHING;

-- ===== 018_document_expiry.sql =====
ALTER TABLE document.documents ADD COLUMN IF NOT EXISTS expires_on DATE;

-- "Live documents expiring before X", the FMS-26 query.
CREATE INDEX IF NOT EXISTS idx_document_expires_on
    ON document.documents(expires_on)
    WHERE deleted_at IS NULL AND expires_on IS NOT NULL;

-- ===== 019_depot_management.sql =====
ALTER TABLE fleet.depots ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_fleet_depots_version
    BEFORE UPDATE ON fleet.depots
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

UPDATE fleet.depots SET code = upper(btrim(code)) WHERE code IS NOT NULL AND code <> upper(btrim(code));

DELETE FROM auth.role_permissions rp
 USING auth.roles r, auth.permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.name = 'fleet_manager' AND p.code = 'depot:write';

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'fleet_owner' AND p.code = 'depot:write'
ON CONFLICT DO NOTHING;

-- ===== 020_maintenance_records.sql =====
ALTER TABLE maintenance.maintenance_records ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maintenance.maintenance_records
    ADD COLUMN IF NOT EXISTS completed_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE TRIGGER trg_maintenance_records_version
    BEFORE UPDATE ON maintenance.maintenance_records
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

-- ===== 021_inventory_parts.sql =====
ALTER TABLE maintenance.inventory_parts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_maintenance_inventory_parts_version
    BEFORE UPDATE ON maintenance.inventory_parts
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

UPDATE maintenance.inventory_parts SET part_number = upper(btrim(part_number))
 WHERE part_number <> upper(btrim(part_number));

CREATE INDEX IF NOT EXISTS idx_inventory_parts_below_reorder
    ON maintenance.inventory_parts(depot_id)
    WHERE is_active AND stock_quantity <= reorder_threshold;

-- ===== 022_user_administration.sql =====
CREATE TABLE IF NOT EXISTS auth.password_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    purpose     VARCHAR(10) NOT NULL,
    token_hash  CHAR(64) NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_by  BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_password_token_purpose CHECK (purpose IN ('setup', 'reset')),
    CONSTRAINT chk_password_token_expiry CHECK (expires_at > created_at)
);

-- The open tokens of a user: issuing a new one closes the older ones.
CREATE INDEX IF NOT EXISTS idx_password_tokens_open
    ON auth.password_tokens(user_id)
    WHERE used_at IS NULL;

-- ===== 023_job_runs_and_expiry_notices.sql =====
CREATE SCHEMA IF NOT EXISTS jobs;

CREATE TABLE IF NOT EXISTS jobs.job_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_name        VARCHAR(100) NOT NULL,
    run_key         VARCHAR(100) NOT NULL,
    status          VARCHAR(20)  NOT NULL,
    instance_id     VARCHAR(200) NOT NULL,
    correlation_id  UUID         NOT NULL,
    attempts        INTEGER      NOT NULL DEFAULT 1,
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_until     TIMESTAMPTZ  NOT NULL,
    finished_at     TIMESTAMPTZ,
    result          JSONB,
    error           TEXT,
    CONSTRAINT uq_job_runs_job_key UNIQUE (job_name, run_key),
    CONSTRAINT chk_job_run_status CHECK (status IN ('running', 'succeeded', 'failed')),
    CONSTRAINT chk_job_run_attempts CHECK (attempts >= 1),
    CONSTRAINT chk_job_run_result CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_job_runs_recent ON jobs.job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS fleet.expiry_notices (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_type    VARCHAR(20) NOT NULL,
    subject_id      BIGINT      NOT NULL,
    expires_on      DATE        NOT NULL,
    level           VARCHAR(10) NOT NULL,
    days_left       INTEGER     NOT NULL,
    correlation_id  UUID        NOT NULL,
    notified_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_expiry_notice UNIQUE (subject_type, subject_id, expires_on, level),
    CONSTRAINT chk_expiry_notice_subject CHECK (subject_type IN ('document', 'licence')),
    CONSTRAINT chk_expiry_notice_level CHECK (level IN ('amber', 'red'))
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA jobs TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON jobs.job_runs TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA jobs TO fms_app;
    END IF;
END $$;

-- ===== 024_audit_source_and_result.sql =====
ALTER TABLE audit.audit_logs ADD COLUMN IF NOT EXISTS request_source JSONB;
ALTER TABLE audit.audit_logs ADD COLUMN IF NOT EXISTS result VARCHAR(20);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_result') THEN
        ALTER TABLE audit.audit_logs
            ADD CONSTRAINT chk_audit_result CHECK (result IS NOT NULL AND result IN ('success', 'denied', 'failed')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_request_source') THEN
        ALTER TABLE audit.audit_logs
            ADD CONSTRAINT chk_audit_request_source CHECK (
                request_source IS NOT NULL
                AND jsonb_typeof(request_source) = 'object'
                AND request_source->>'channel' IN ('web', 'pwa', 'job', 'webhook', 'script')
            ) NOT VALID;
    END IF;
END $$;

-- Denied and failed actions, newest first (security review).
CREATE INDEX IF NOT EXISTS idx_audit_logs_not_success
    ON audit.audit_logs (created_at DESC)
    WHERE result IN ('denied', 'failed');

-- ===== 025_audit_reader.sql =====
CREATE INDEX IF NOT EXISTS idx_audit_logs_recent
    ON audit.audit_logs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_public
    ON audit.audit_logs ((COALESCE(new_values->>'public_id', old_values->>'public_id')), created_at DESC, id DESC);

DELETE FROM auth.role_permissions rp
 USING auth.roles r, auth.permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.name = 'fleet_manager' AND p.code = 'audit:read';

-- ===== 026_domain_event_outbox.sql =====
CREATE SCHEMA IF NOT EXISTS events;
REVOKE CREATE ON SCHEMA events FROM PUBLIC;

CREATE TABLE IF NOT EXISTS events.outbox (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          UUID         NOT NULL,
    event_type        VARCHAR(100) NOT NULL,
    event_version     SMALLINT     NOT NULL DEFAULT 1,
    occurred_at       TIMESTAMPTZ  NOT NULL,
    actor_id          UUID,
    correlation_id    UUID         NOT NULL,
    payload           JSONB        NOT NULL,
    aggregate_key     VARCHAR(200),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    dispatched_at     TIMESTAMPTZ,
    published_at      TIMESTAMPTZ,
    attempts          INTEGER      NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ,
    last_error        TEXT,
    dead_lettered_at  TIMESTAMPTZ,
    CONSTRAINT uq_outbox_event_id UNIQUE (event_id),
    CONSTRAINT chk_outbox_event_type CHECK (event_type ~ '^[A-Z][A-Za-z0-9]*$'),
    CONSTRAINT chk_outbox_event_version CHECK (event_version >= 1),
    CONSTRAINT chk_outbox_payload CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_outbox_dead_letter CHECK (dead_lettered_at IS NULL OR dispatched_at IS NULL)
);

-- What the relay still has to dispatch, oldest first, and (for the order
-- per aggregate) whether an older event of the same aggregate is waiting.
CREATE INDEX IF NOT EXISTS idx_outbox_undispatched
    ON events.outbox (id) WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_undispatched_aggregate
    ON events.outbox (aggregate_key, id) WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL AND aggregate_key IS NOT NULL;
-- What it still has to put on Redis.
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON events.outbox (id) WHERE published_at IS NULL;
-- Dead letters, for the lag report.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
    ON events.outbox (id) WHERE dead_lettered_at IS NOT NULL;
-- The daily clean-up of delivered rows.
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON events.outbox (created_at);

CREATE TABLE IF NOT EXISTS events.processed_events (
    consumer      VARCHAR(100) NOT NULL,
    event_id      UUID         NOT NULL,
    processed_at  TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_processed_events PRIMARY KEY (consumer, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_at ON events.processed_events (processed_at);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA events TO fms_app;
        -- DELETE: only the daily clean-up of delivered rows.
        GRANT SELECT, INSERT, UPDATE, DELETE ON events.outbox TO fms_app;
        GRANT SELECT, INSERT, DELETE ON events.processed_events TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA events TO fms_app;
    END IF;
END $$;

-- ===== 027_route_management.sql =====
ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_trip_routes_version
    BEFORE UPDATE ON trip.routes
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS stops JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_stops
        CHECK (jsonb_typeof(stops) = 'array' AND jsonb_array_length(stops) <= 25);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_origin_pair
        CHECK ((origin_latitude IS NULL) = (origin_longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_destination_pair
        CHECK ((destination_latitude IS NULL) = (destination_longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_trip_routes_depot_name
    ON trip.routes (depot_id, lower(name))
    WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_trip_routes_depot ON trip.routes (depot_id);

-- ===== 028_trip_history.sql =====
CREATE INDEX IF NOT EXISTS idx_trip_trips_history
    ON trip.trips ((COALESCE(scheduled_start, created_at)), id);

CREATE INDEX IF NOT EXISTS idx_trip_trips_route
    ON trip.trips (route_id);

-- ===== 029_vehicle_availability.sql =====
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

-- ===== 030_trip_overlap_inclusive.sql =====
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

-- ===== 031_integration_gateway.sql =====
ALTER TABLE integration.external_providers ADD COLUMN IF NOT EXISTS code VARCHAR(50);

-- Rows from before this migration get a slug from their name and id.
UPDATE integration.external_providers
   SET code = left(trim(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 40) || '-' || id
 WHERE code IS NULL;

ALTER TABLE integration.external_providers ALTER COLUMN code SET NOT NULL;

DO $$ BEGIN
    ALTER TABLE integration.external_providers
        ADD CONSTRAINT chk_provider_code CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_providers_code
    ON integration.external_providers(code);

-- Webhook de-duplication (api-contract §15): one inbound row per provider event.
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_sync_logs_inbound_reference
    ON integration.sync_logs(provider_id, external_reference)
    WHERE direction = 'inbound' AND external_reference IS NOT NULL;

-- The running sync of a provider, if any (a second manual sync joins it).
CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_running
    ON integration.sync_logs(provider_id, started_at DESC)
    WHERE status = 'started';

-- ===== 032_gps_ingestion.sql =====
ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_gps_devices_public_id ON integration.gps_devices(public_id);

ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS token_hash CHAR(64);
ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS token_issued_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_gps_devices_token
    ON integration.gps_devices(token_hash)
    WHERE token_hash IS NOT NULL;

-- A provider's devices by the identifier its webhooks use.
CREATE INDEX IF NOT EXISTS idx_integration_gps_devices_provider
    ON integration.gps_devices(provider_id, device_identifier);

ALTER TABLE tracking.vehicle_current_location ADD COLUMN IF NOT EXISTS event_recorded_at TIMESTAMPTZ;

-- ===== 033_alert_engine.sql =====
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS depot_id BIGINT REFERENCES fleet.depots(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS trip_id BIGINT REFERENCES trip.trips(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS entity_type VARCHAR(30);
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS source_event_id UUID;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS dedup_key VARCHAR(255);
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS escalation_level SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS acknowledged_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS resolved_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$ BEGIN
    ALTER TABLE alert.alerts ADD CONSTRAINT chk_alert_occurrences CHECK (occurrence_count >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE alert.alerts ADD CONSTRAINT chk_alert_escalation CHECK (escalation_level >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE alert.alerts ADD CONSTRAINT chk_alert_details CHECK (jsonb_typeof(details) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The active alert of a source, for de-duplication.
CREATE INDEX IF NOT EXISTS idx_alerts_dedup_active
    ON alert.alerts(dedup_key, last_occurred_at DESC)
    WHERE status IN ('open', 'acknowledged');

-- A depot's alerts, newest first (GET /alerts).
CREATE INDEX IF NOT EXISTS idx_alerts_depot_time
    ON alert.alerts(depot_id, created_at DESC);

-- Critical alerts nobody has acknowledged yet (the escalation job).
CREATE INDEX IF NOT EXISTS idx_alerts_escalation_due
    ON alert.alerts(created_at)
    WHERE status = 'open' AND severity = 'critical';

-- ===== 034_incident_reports.sql =====
ALTER TABLE alert.incident_reports ADD COLUMN IF NOT EXISTS depot_id BIGINT REFERENCES fleet.depots(id) ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE alert.incident_reports i
   SET depot_id = v.depot_id
  FROM fleet.vehicles v
 WHERE i.depot_id IS NULL AND v.id = i.vehicle_id;

DO $$ BEGIN
    ALTER TABLE alert.incident_reports ADD CONSTRAINT chk_incident_location
        CHECK ((latitude IS NULL) = (longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A depot's incidents, newest first (GET /incidents for staff).
CREATE INDEX IF NOT EXISTS idx_incidents_depot_time
    ON alert.incident_reports(depot_id, occurred_at DESC);

-- A reporter's own incidents, newest first (GET /incidents for a driver),
-- and the replay check of a late offline submission.
CREATE INDEX IF NOT EXISTS idx_incidents_reporter_time
    ON alert.incident_reports(reported_by, occurred_at DESC);

-- ===== 035_telemetry_rules.sql =====
CREATE TABLE IF NOT EXISTS tracking.rule_thresholds (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- NULL: the whole fleet's thresholds; a depot's row overrides them.
    depot_id           BIGINT REFERENCES fleet.depots(id)
                       ON DELETE CASCADE ON UPDATE CASCADE,
    speed_limit_kmh    SMALLINT NOT NULL DEFAULT 80,
    -- Consecutive pings over the limit that raise a speeding flag.
    speeding_pings     SMALLINT NOT NULL DEFAULT 3,
    -- Consecutive pings at or under the limit that resolve it.
    clear_pings        SMALLINT NOT NULL DEFAULT 3,
    -- Minutes at 0 km/h, engine not reported off, that raise an idling flag.
    idle_minutes       SMALLINT NOT NULL DEFAULT 5,
    updated_by         BIGINT REFERENCES auth.users(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_rule_thresholds_depot UNIQUE NULLS NOT DISTINCT (depot_id),
    CONSTRAINT chk_rule_speed_limit CHECK (speed_limit_kmh BETWEEN 20 AND 200),
    CONSTRAINT chk_rule_speeding_pings CHECK (speeding_pings BETWEEN 1 AND 20),
    CONSTRAINT chk_rule_clear_pings CHECK (clear_pings BETWEEN 1 AND 20),
    CONSTRAINT chk_rule_idle_minutes CHECK (idle_minutes BETWEEN 1 AND 120)
);

CREATE OR REPLACE TRIGGER trg_tracking_rule_thresholds_updated_at
    BEFORE UPDATE ON tracking.rule_thresholds
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

INSERT INTO tracking.rule_thresholds (depot_id) VALUES (NULL)
    ON CONFLICT ON CONSTRAINT ux_rule_thresholds_depot DO NOTHING;

UPDATE tracking.telemetry_flags f
   SET resolved_at = d.newest_observed_at
  FROM (SELECT id,
               first_value(observed_at) OVER w AS newest_observed_at,
               row_number() OVER w AS rn
          FROM tracking.telemetry_flags
         WHERE resolved_at IS NULL
        WINDOW w AS (PARTITION BY vehicle_id, flag_type ORDER BY observed_at DESC, id DESC)) d
 WHERE f.id = d.id AND d.rn > 1;

-- The flag of a type a vehicle has while its condition lasts: at most one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_telemetry_flags_ongoing
    ON tracking.telemetry_flags(vehicle_id, flag_type)
    WHERE resolved_at IS NULL;

-- ===== 036_failure_events.sql =====
DO $$ BEGIN
    CREATE TYPE maintenance.failure_component AS ENUM
        ('engine', 'cooling', 'brakes', 'tyres', 'transmission', 'electrical', 'suspension',
         'steering', 'fuel_system', 'exhaust', 'body', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.failure_mode AS ENUM
        ('wear', 'leak', 'overheating', 'electrical_fault', 'breakage', 'puncture', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.failure_detection AS ENUM
        ('driver_report', 'dvir', 'technician', 'telematics', 'breakdown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.failure_events (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id             BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                           ON DELETE RESTRICT ON UPDATE CASCADE,
    -- The repair that found it, or the incident that reported it.
    maintenance_record_id  BIGINT REFERENCES maintenance.maintenance_records(id)
                           ON DELETE RESTRICT ON UPDATE CASCADE,
    incident_report_id     BIGINT REFERENCES alert.incident_reports(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    component              maintenance.failure_component NOT NULL,
    failure_mode           maintenance.failure_mode NOT NULL,
    -- A breakdown or a fault found in service; FALSE: found at planned work.
    unplanned              BOOLEAN NOT NULL,
    detected_by            maintenance.failure_detection NOT NULL,
    occurred_at            TIMESTAMPTZ NOT NULL,
    odometer_km            NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    notes                  TEXT,
    recorded_by            BIGINT REFERENCES auth.users(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_failure_source
        CHECK (maintenance_record_id IS NOT NULL OR incident_report_id IS NOT NULL)
);

-- A vehicle's failures, newest first (GET /failure-events?vehicle_id=, the training set per vehicle).
CREATE INDEX IF NOT EXISTS idx_failure_events_vehicle_time
    ON maintenance.failure_events(vehicle_id, occurred_at DESC);

-- A component's failures across the fleet (what breaks, how often).
CREATE INDEX IF NOT EXISTS idx_failure_events_component_time
    ON maintenance.failure_events(component, occurred_at DESC);

-- A repair's failures (the completion check, the record view).
CREATE INDEX IF NOT EXISTS idx_failure_events_record
    ON maintenance.failure_events(maintenance_record_id)
    WHERE maintenance_record_id IS NOT NULL;

-- ===== 037_part_service_items.sql =====
DO $$ BEGIN
    CREATE TYPE maintenance.service_item AS ENUM
        ('engine_oil', 'air_filter', 'fuel_filter', 'coolant', 'brake_pads', 'brake_fluid',
         'clutch_fluid', 'tyres', 'battery', 'gearbox_oil', 'belts');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE maintenance.inventory_parts ADD COLUMN IF NOT EXISTS service_item maintenance.service_item;

CREATE INDEX IF NOT EXISTS idx_inventory_parts_service_item
    ON maintenance.inventory_parts(service_item)
    WHERE service_item IS NOT NULL;

-- ===== 038_meter_readings.sql =====
DO $$ BEGIN
    CREATE TYPE fleet.meter_type AS ENUM ('odometer', 'engine_hours');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE fleet.meter_source AS ENUM ('fuel_log', 'maintenance', 'telematics', 'gps_derived', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fleet.meter_readings (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id   BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                 ON DELETE RESTRICT ON UPDATE CASCADE,
    meter        fleet.meter_type NOT NULL,
    -- km for the odometer, hours for engine hours.
    value        NUMERIC(12,1) NOT NULL CHECK (value >= 0),
    source       fleet.meter_source NOT NULL,
    source_ref   TEXT,
    -- When the reading was true (the fill-up, the repair's completion, the ping, the end of the day).
    recorded_at  TIMESTAMPTZ NOT NULL,
    -- Lower than a trusted reading recorded before it: kept, not trusted.
    suspect      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A vehicle's history of one meter, newest first (GET /vehicles/{id}/meter-readings, the floor check).
CREATE INDEX IF NOT EXISTS idx_meter_readings_vehicle_meter_time
    ON fleet.meter_readings(vehicle_id, meter, recorded_at DESC);

-- One reading per fuel log, repair and engine-hours day.
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_readings_source_record
    ON fleet.meter_readings(vehicle_id, meter, source, source_ref)
    WHERE source IN ('fuel_log', 'maintenance', 'gps_derived');

INSERT INTO fleet.meter_readings (vehicle_id, meter, value, source, recorded_at)
SELECT v.id, 'odometer', v.odometer_km, 'manual', v.updated_at
  FROM fleet.vehicles v
 WHERE NOT EXISTS (SELECT 1 FROM fleet.meter_readings m WHERE m.vehicle_id = v.id AND m.meter = 'odometer');

-- ===== 039_ml_models.sql =====
DO $$ BEGIN
    CREATE TYPE maintenance.ml_model_status AS ENUM ('registered', 'active', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.ml_models (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id             UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    name                  VARCHAR(100) NOT NULL,
    version               VARCHAR(100) NOT NULL,
    algorithm             TEXT NOT NULL,
    -- The model's inputs, in the order it takes them.
    features              JSONB NOT NULL,
    feature_spec_version  INTEGER NOT NULL CHECK (feature_spec_version > 0),
    -- SHA-256 (hex) of the canonical feature definitions (feature_spec.json).
    feature_spec_hash     CHAR(64) NOT NULL CHECK (feature_spec_hash ~ '^[0-9a-f]{64}$'),
    -- Precision, recall, F1 at the alert line, ROC-AUC and the rest, measured on held-out vehicles.
    metrics               JSONB NOT NULL,
    -- Which data: file and its hash, rows, vehicles, dates, split.
    training_data         JSONB NOT NULL,
    trained_at            TIMESTAMPTZ NOT NULL,
    artefact_sha256       CHAR(64) NOT NULL CHECK (artefact_sha256 ~ '^[0-9a-f]{64}$'),
    status                maintenance.ml_model_status NOT NULL DEFAULT 'registered',
    -- When the scoring job first saw the service serve it.
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at          TIMESTAMPTZ,
    activated_by          BIGINT REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    retired_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_ml_models_name_version UNIQUE (name, version),
    CONSTRAINT chk_ml_models_features CHECK (jsonb_typeof(features) = 'array' AND jsonb_array_length(features) > 0),
    CONSTRAINT chk_ml_models_metrics CHECK (jsonb_typeof(metrics) = 'object'),
    CONSTRAINT chk_ml_models_training_data CHECK (jsonb_typeof(training_data) = 'object'),
    CONSTRAINT chk_ml_models_activated CHECK (status <> 'active' OR activated_at IS NOT NULL),
    CONSTRAINT chk_ml_models_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- One active model per name: the one that scores.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_models_active
    ON maintenance.ml_models(name)
    WHERE status = 'active';

-- GET /ml-models: newest first.
CREATE INDEX IF NOT EXISTS idx_ml_models_first_seen
    ON maintenance.ml_models(first_seen_at DESC, id DESC);

CREATE OR REPLACE TRIGGER trg_ml_models_updated_at
    BEFORE UPDATE ON maintenance.ml_models
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- Nothing has stored a prediction yet (the nightly scoring is FMS-55), so every
-- existing row, if any, would have to name a registered model already.
DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_predictions
        ADD CONSTRAINT fk_predictions_ml_model FOREIGN KEY (model_name, model_version)
        REFERENCES maintenance.ml_models(name, version) ON DELETE RESTRICT ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_predictions_model
    ON maintenance.maintenance_predictions(model_name, model_version);

INSERT INTO auth.permissions (code, description) VALUES
    ('ml-model:activate', 'Allow a registered predictive-maintenance model to score')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'admin' AND p.code = 'ml-model:activate'
ON CONFLICT DO NOTHING;

-- ===== 040_prediction_scores.sql =====
ALTER TABLE maintenance.maintenance_predictions
    ADD COLUMN IF NOT EXISTS health_score SMALLINT,
    ADD COLUMN IF NOT EXISTS risk_level   VARCHAR(10),
    ADD COLUMN IF NOT EXISTS factors      JSONB,
    ADD COLUMN IF NOT EXISTS as_of        TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_predictions
        ADD CONSTRAINT chk_prediction_health_score CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100),
        ADD CONSTRAINT chk_prediction_risk_level CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
        ADD CONSTRAINT chk_prediction_factors
            CHECK (factors IS NULL OR (jsonb_typeof(factors) = 'array' AND jsonb_array_length(factors) <= 3)),
        ADD CONSTRAINT chk_prediction_scored
            CHECK ((health_score IS NULL) = (risk_level IS NULL)
               AND (health_score IS NULL) = (factors IS NULL)
               AND (health_score IS NULL) = (as_of IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_predictions_scoring
    ON maintenance.maintenance_predictions(vehicle_id, prediction_type, as_of, model_name, model_version)
    WHERE as_of IS NOT NULL;

-- ===== 041_fuel_reconciliation.sql =====
ALTER TABLE fuel.fuel_anomalies
    ALTER COLUMN fuel_log_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS period_end   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS distance_km  NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS expected_ml  BIGINT,
    ADD COLUMN IF NOT EXISTS actual_ml    BIGINT;

DO $$ BEGIN
    ALTER TABLE fuel.fuel_anomalies
        ADD CONSTRAINT chk_fuel_anomaly_period
            CHECK ((period_start IS NULL) = (period_end IS NULL) AND (period_end IS NULL OR period_end > period_start)),
        ADD CONSTRAINT chk_fuel_anomaly_subject
            CHECK (fuel_log_id IS NOT NULL
                OR (period_start IS NOT NULL AND distance_km IS NOT NULL AND expected_ml IS NOT NULL AND actual_ml IS NOT NULL)),
        ADD CONSTRAINT chk_fuel_anomaly_amounts
            CHECK ((distance_km IS NULL OR distance_km >= 0) AND (expected_ml IS NULL OR expected_ml >= 0) AND (actual_ml IS NULL OR actual_ml >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_fuel_anomalies_period
    ON fuel.fuel_anomalies(vehicle_id, period_start, period_end)
    WHERE period_start IS NOT NULL;

-- ===== 042_gps_recorded_time_trips.sql =====
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

-- ===== 043_prediction_feedback.sql =====
DO $$ BEGIN
    CREATE TYPE maintenance.prediction_outcome AS ENUM
        ('confirmed_issue', 'no_issue_found', 'already_fixed', 'not_inspected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.prediction_feedback (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    prediction_id    BIGINT NOT NULL REFERENCES maintenance.maintenance_predictions(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    user_id          BIGINT NOT NULL REFERENCES auth.users(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    outcome          maintenance.prediction_outcome NOT NULL,
    component        maintenance.failure_component,
    failure_event_id BIGINT REFERENCES maintenance.failure_events(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    comment          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_prediction_feedback_prediction UNIQUE (prediction_id),
    -- What was found, and the failure it led to, only mean something for a confirmed issue.
    CONSTRAINT chk_prediction_feedback_found
        CHECK (outcome = 'confirmed_issue' OR (component IS NULL AND failure_event_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_prediction_feedback_failure
    ON maintenance.prediction_feedback(failure_event_id)
    WHERE failure_event_id IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_prediction_feedback_updated_at
    BEFORE UPDATE ON maintenance.prediction_feedback
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- ===== 044_analytics_kpis.sql =====
ALTER TABLE analytics.analytics_cache
    ADD COLUMN IF NOT EXISTS distance_m             BIGINT  NOT NULL DEFAULT 0 CHECK (distance_m >= 0),
    ADD COLUMN IF NOT EXISTS trips_completed        INTEGER NOT NULL DEFAULT 0 CHECK (trips_completed >= 0),
    ADD COLUMN IF NOT EXISTS trips_timed            INTEGER NOT NULL DEFAULT 0 CHECK (trips_timed >= 0),
    ADD COLUMN IF NOT EXISTS trips_on_time          INTEGER NOT NULL DEFAULT 0 CHECK (trips_on_time >= 0),
    ADD COLUMN IF NOT EXISTS fuel_ml                BIGINT  NOT NULL DEFAULT 0 CHECK (fuel_ml >= 0),
    ADD COLUMN IF NOT EXISTS fuel_cost_cents        BIGINT  NOT NULL DEFAULT 0 CHECK (fuel_cost_cents >= 0),
    ADD COLUMN IF NOT EXISTS maintenance_cost_cents BIGINT  NOT NULL DEFAULT 0 CHECK (maintenance_cost_cents >= 0);

CREATE INDEX IF NOT EXISTS idx_analytics_cache_period
    ON analytics.analytics_cache(period_type, period_start);

CREATE OR REPLACE VIEW analytics.vehicle_directory AS
SELECT
    v.id AS vehicle_id,
    v.public_id,
    v.registration_number,
    v.make,
    v.model,
    v.status,
    v.fuel_type,
    v.fuel_efficiency_ml_per_km,
    v.health_score,
    v.maintenance_flag,
    v.depot_id,
    d.public_id AS depot_public_id,
    d.name AS depot_name
FROM fleet.vehicles v
JOIN fleet.depots d ON d.id = v.depot_id;

CREATE OR REPLACE VIEW analytics.trip_facts AS
SELECT
    t.id AS trip_id,
    t.vehicle_id,
    t.status,
    t.scheduled_start,
    t.scheduled_end,
    t.actual_start,
    t.actual_end,
    t.actual_distance_km
FROM trip.trips t;

CREATE OR REPLACE VIEW analytics.fuel_facts AS
SELECT f.vehicle_id, f.recorded_at, f.quantity_ml, f.total_cost_cents
FROM fuel.fuel_logs f;

CREATE OR REPLACE VIEW analytics.maintenance_cost_facts AS
SELECT m.vehicle_id, m.completed_at, m.total_cost_cents
FROM maintenance.maintenance_records m
WHERE m.status = 'completed' AND m.completed_at IS NOT NULL;

CREATE OR REPLACE VIEW analytics.alert_facts AS
SELECT
    a.id AS alert_id,
    a.vehicle_id,
    COALESCE(a.depot_id, v.depot_id) AS depot_id,
    a.alert_type,
    a.severity,
    a.status,
    a.created_at,
    a.acknowledged_at
FROM alert.alerts a
LEFT JOIN fleet.vehicles v ON v.id = a.vehicle_id;

-- ===== 045_route_roads.sql =====
ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS measured_at TIMESTAMPTZ;
ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS distance_source VARCHAR(10);

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_distance_source
        CHECK (distance_source IS NULL OR distance_source IN ('road', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_geometry_line
        CHECK (geometry IS NULL OR (geometry->>'type' = 'LineString' AND jsonb_typeof(geometry->'coordinates') = 'array'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_measured
        CHECK ((geometry IS NULL) = (measured_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE trip.routes SET distance_source = 'manual' WHERE distance_km IS NOT NULL AND distance_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_trip_routes_unmeasured
    ON trip.routes (id)
    WHERE is_active AND geometry IS NULL AND origin_latitude IS NOT NULL AND destination_latitude IS NOT NULL;
