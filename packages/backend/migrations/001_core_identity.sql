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

INSERT INTO auth.permissions (code, description) VALUES
    ('users.read', 'Read user profiles'),
    ('users.write', 'Create and update user profiles'),
    ('fleet.read', 'Read fleet data'),
    ('fleet.write', 'Create and update fleet data'),
    ('trip.read', 'Read trips and routes'),
    ('trip.write', 'Create and update trips and routes'),
    ('fuel.read', 'Read fuel records'),
    ('fuel.write', 'Create and update fuel records'),
    ('maintenance.read', 'Read maintenance records'),
    ('maintenance.write', 'Create and update maintenance records'),
    ('alerts.read', 'Read alerts and notifications'),
    ('alerts.write', 'Create, acknowledge and resolve alerts'),
    ('analytics.read', 'Read analytics and reporting'),
    ('command_center.read', 'Read live command-center data'),
    ('ev.read', 'Read EV fleet data'),
    ('ev.write', 'Create and update EV fleet data'),
    ('audit.read', 'Read audit records'),
    ('integration.manage', 'Manage integration configuration'),
    ('dvir.read', 'Read driver vehicle inspection reports'),
    ('dvir.write', 'Create and update driver vehicle inspection reports'),
    ('incident.read', 'Read incidents'),
    ('incident.write', 'Create and update incidents'),
    ('attendance.read', 'Read driver attendance'),
    ('attendance.write', 'Create and update driver attendance'),
    ('driver.self.read', 'Read own driver operational information'),
    ('driver.self.write', 'Write own driver operational information')
ON CONFLICT (code) DO NOTHING;

-- Admin receives every permission.
INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
CROSS JOIN auth.permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Explicit least-privilege assignments for the remaining roles.
INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'users.read', 'fleet.read', 'fleet.write', 'trip.read', 'trip.write',
    'fuel.read', 'fuel.write', 'maintenance.read', 'maintenance.write',
    'alerts.read', 'alerts.write', 'analytics.read', 'command_center.read',
    'ev.read', 'ev.write', 'dvir.read', 'dvir.write', 'incident.read',
    'incident.write', 'attendance.read', 'attendance.write', 'audit.read',
    'integration.manage'
)
WHERE r.name = 'fleet_manager'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'fleet.read', 'trip.read', 'trip.write', 'alerts.read', 'alerts.write',
    'command_center.read', 'analytics.read'
)
WHERE r.name = 'dispatcher'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'fleet.read', 'maintenance.read', 'maintenance.write',
    'dvir.read', 'dvir.write', 'incident.read', 'incident.write'
)
WHERE r.name = 'technician'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'fleet.read', 'fleet.write', 'trip.read', 'fuel.read', 'fuel.write',
    'maintenance.read', 'maintenance.write', 'alerts.read',
    'command_center.read', 'ev.read', 'ev.write', 'dvir.read', 'dvir.write',
    'incident.read', 'incident.write', 'attendance.read', 'attendance.write'
)
WHERE r.name = 'depot_admin'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN ('fuel.read', 'fuel.write', 'analytics.read')
WHERE r.name = 'finance_clerk'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'users.read', 'fleet.read', 'trip.read', 'fuel.read', 'maintenance.read',
    'alerts.read', 'analytics.read', 'audit.read', 'dvir.read',
    'incident.read', 'attendance.read'
)
WHERE r.name = 'compliance_officer'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'fleet.read', 'trip.read', 'fuel.read', 'maintenance.read',
    'alerts.read', 'analytics.read', 'command_center.read', 'ev.read'
)
WHERE r.name = 'fleet_owner'
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM auth.roles r
JOIN auth.permissions p ON p.code IN (
    'fleet.read', 'trip.read', 'fuel.write', 'dvir.write', 'incident.write',
    'driver.self.read', 'driver.self.write', 'dvir.read', 'incident.read'
)
WHERE r.name = 'driver'
ON CONFLICT DO NOTHING;

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
