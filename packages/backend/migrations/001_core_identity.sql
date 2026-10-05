-- =====================================================================
-- Fleet Management System - PostgreSQL Migrations
-- 001_core_identity.sql
--
-- Architecture boundary:
--   shared.*   -> shared database primitives/types/functions
--   auth.*     -> identity, authentication and RBAC
--
-- This is a replacement baseline for a NEW PostgreSQL database.
-- It supersedes the earlier public.* identity tables.
-- =====================================================================

-- +migrate Up

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

-- +migrate Down

DROP TABLE IF EXISTS auth.refresh_sessions;
DROP TABLE IF EXISTS auth.user_roles;
DROP TABLE IF EXISTS auth.role_permissions;
DROP TABLE IF EXISTS auth.permissions;
DROP TABLE IF EXISTS auth.users;
DROP TABLE IF EXISTS auth.roles;

DROP TYPE IF EXISTS shared.user_status;
DROP TYPE IF EXISTS shared.fuel_type;
DROP TYPE IF EXISTS shared.vehicle_type;
DROP TYPE IF EXISTS shared.vehicle_status;

DROP FUNCTION IF EXISTS shared.bump_version();
DROP FUNCTION IF EXISTS shared.set_updated_at();
DROP SCHEMA IF EXISTS auth;
DROP SCHEMA IF EXISTS shared;
