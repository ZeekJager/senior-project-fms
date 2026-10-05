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
