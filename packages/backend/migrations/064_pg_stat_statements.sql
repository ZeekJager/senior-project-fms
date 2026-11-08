-- =====================================================================
-- 064_pg_stat_statements.sql
-- Query statistics for the database (FMS-75, docs/metrics.md): the
-- slowest and most frequent SQL, from pg_stat_statements.
--
-- The extension only collects once the server preloads it
-- (shared_preload_libraries = pg_stat_statements: the Compose stack sets
-- it; a managed database has its own switch). Creating it needs no
-- preload, so this migration runs everywhere; reading the view before
-- the preload is a clear error from PostgreSQL, not wrong data.
--
-- A server without the extension files, or a role that may not create
-- it, gets a notice and the migration passes: statistics are a
-- convenience, and the application never depends on them.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
    WHEN undefined_file OR feature_not_supported OR insufficient_privilege THEN
        RAISE NOTICE 'pg_stat_statements is not available here (%): query statistics are off', SQLERRM;
END $$;

-- +migrate Down

DROP EXTENSION IF EXISTS pg_stat_statements;
