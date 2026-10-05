-- =====================================================================
-- 012_app_grants.sql
-- Runtime privileges for the application role (fms_app).
--
-- Migrations run as the schema owner (fms_admin in the docker stack).
-- 001-011 create every object in non-public schemas, and the docker
-- init script only grants fms_app access to `public`, so without this
-- file the backend gets "permission denied for schema ..." everywhere.
--
-- Policy:
--   * CRUD on every table in the module schemas (new tables created by
--     later migrations inherit it via default privileges).
--   * analytics.* is read-only (views).
--   * audit.audit_logs is INSERT + SELECT only. The append-only trigger
--     from 010 blocks UPDATE/DELETE for everyone; withholding the
--     privilege as well means the app role is refused before the
--     trigger even runs, and cannot TRUNCATE.
--
-- Skipped with a NOTICE when fms_app does not exist (e.g. a developer
-- database not created through docker/postgres/init).
-- =====================================================================

-- +migrate Up

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
                             'alert', 'ev']
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

    -- Append-only audit trail: no defaults, explicit table grants only.
    GRANT USAGE ON SCHEMA audit TO fms_app;
    GRANT SELECT, INSERT ON audit.audit_logs TO fms_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO fms_app;
END $$;

-- +migrate Down

DO $$
DECLARE
    s text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        RETURN;
    END IF;

    -- Default privileges must go first: they are catalog dependencies of
    -- the schemas and would make the later DROP SCHEMA statements fail.
    FOREACH s IN ARRAY ARRAY['shared', 'auth', 'fleet', 'trip', 'fuel',
                             'maintenance', 'integration', 'tracking',
                             'alert', 'ev', 'analytics']
    LOOP
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM fms_app', s);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM fms_app', s);
    END LOOP;

    FOREACH s IN ARRAY ARRAY['shared', 'auth', 'fleet', 'trip', 'fuel',
                             'maintenance', 'integration', 'tracking',
                             'alert', 'ev', 'analytics', 'audit']
    LOOP
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM fms_app', s);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM fms_app', s);
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM fms_app', s);
    END LOOP;
END $$;
