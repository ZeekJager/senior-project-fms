-- =====================================================================
-- Migration: 001_core_identity
-- Ticket:    FMS-01 — DB Migrations: Core Identity Tables
-- Target:    packages/backend/migrations/001_core_identity.sql
-- Tables:    roles, depots, users
--
-- Spec:    docs/schema-fms.sql (MySQL), translated to PostgreSQL
--          (the docker stack runs postgres:16):
--   TINYINT(1)      -> BOOLEAN
--   JSON            -> JSONB
--   AUTO_INCREMENT  -> SERIAL
--
-- Up/Down split marker below follows the sql-migrate convention
-- ("-- +migrate Up" / "-- +migrate Down"). If your migration runner
-- expects a different marker, swap just these two lines.
-- =====================================================================

-- +migrate Up

-- Postgres has no native "ON UPDATE CURRENT_TIMESTAMP" column option,
-- so updated_at is maintained by a BEFORE UPDATE trigger instead. One
-- shared function, reused by all three tables below.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- roles
-- Fixed, code-defined role set. Never created via API — rows only ever
-- come from the seed INSERT below. `permissions` is a JSONB blob per
-- the MVP decision (no permissions-as-rows table).
-- Deliberate deviation from docs/schema-fms.sql: roles also carries
-- is_active and updated_at, because the FMS-01 card requires them on
-- ALL tables. (The spec's roles has only created_at.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id          SERIAL       PRIMARY KEY,
    name        VARCHAR(50)  NOT NULL UNIQUE,
    permissions JSONB        NOT NULL DEFAULT '{}'::JSONB,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_roles_updated_at ON roles;
CREATE TRIGGER trg_roles_updated_at
    BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- depots
-- Matches docs/schema-fms.sql: `location` is NOT NULL (POST /depots
-- accepts name + location per api-contract.md). Other depot attributes
-- (timezone, contact info, etc.) aren't specified — later migration.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS depots (
    id          SERIAL       PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    location    VARCHAR(255) NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_depots_updated_at ON depots;
CREATE TRIGGER trg_depots_updated_at
    BEFORE UPDATE ON depots
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- users
-- Matches docs/schema-fms.sql. depot_id is nullable: admins are not
-- depot-scoped. role_id is NOT NULL — every user has exactly one of
-- the 9 seeded roles. password_hash is VARCHAR(255): do not shorten —
-- bcrypt output must not be truncated. (An earlier draft added a
-- full_name column; it is not in the spec or API contract, so removed.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL       PRIMARY KEY,
    depot_id      INTEGER      NULL REFERENCES depots(id)
                                ON DELETE RESTRICT ON UPDATE CASCADE,
    role_id       INTEGER      NOT NULL REFERENCES roles(id)
                                ON DELETE RESTRICT ON UPDATE CASCADE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Seed the 9 fixed roles. ON CONFLICT (name) DO NOTHING + the UNIQUE
-- constraint on `name` makes this safe to run twice (idempotent `up`).
-- permissions is left at its '{}' default for all roles for now.
-- ---------------------------------------------------------------------
INSERT INTO roles (name) VALUES
    ('admin'),
    ('fleet_manager'),
    ('dispatcher'),
    ('driver'),
    ('technician'),
    ('depot_admin'),
    ('finance_clerk'),
    ('compliance_officer'),
    ('fleet_owner')
ON CONFLICT (name) DO NOTHING;


-- +migrate Down

-- Drop in reverse FK order: users (child) before depots/roles
-- (parents), then the shared trigger function last.
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS depots;
DROP TABLE IF EXISTS roles;
DROP FUNCTION IF EXISTS set_updated_at();
