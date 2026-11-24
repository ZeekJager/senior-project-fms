-- =====================================================================
-- 075_base_backups.sql
-- Continuous archiving and point-in-time recovery (FMS-108, ADR-07,
-- docs/backups.md#continuous-archiving-and-point-in-time-recovery).
--
-- * backup.base_backups: each pgBackRest base backup (weekly full, daily
--   differential, and the first full one taken when the repository is
--   empty): when, how big in the database and in the repository, the WAL
--   range it needs, and why it failed. Written by the database container's
--   backup script (docker/postgres/pgbackrest/backup.sh), which connects as
--   the schema owner; the API only reads it. A backup pgBackRest expired by
--   retention is kept as expired, so the history stays.
--   The nightly pg_dump files stay in backup.backups (FMS-144): a dump
--   restores one database anywhere; a base backup plus the archived WAL
--   restores the cluster to any second.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS backup.base_backups (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    label            VARCHAR(60)  UNIQUE,
    backup_type      VARCHAR(4)   NOT NULL,
    triggered_by     VARCHAR(12)  NOT NULL,
    status           VARCHAR(10)  NOT NULL DEFAULT 'running',
    started_at       TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    finished_at      TIMESTAMPTZ,
    size_bytes       BIGINT,
    repo_size_bytes  BIGINT,
    wal_start        VARCHAR(24),
    wal_stop         VARCHAR(24),
    error            TEXT,
    CONSTRAINT chk_base_backup_type CHECK (backup_type IN ('full', 'diff', 'incr')),
    CONSTRAINT chk_base_backup_trigger CHECK (triggered_by IN ('schedule', 'first-start', 'manual')),
    CONSTRAINT chk_base_backup_status CHECK (status IN ('running', 'succeeded', 'failed', 'expired')),
    CONSTRAINT chk_base_backup_succeeded CHECK (status NOT IN ('succeeded', 'expired') OR (label IS NOT NULL AND finished_at IS NOT NULL AND size_bytes IS NOT NULL)),
    CONSTRAINT chk_base_backup_failed CHECK (status <> 'failed' OR (error IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_base_backups_recent ON backup.base_backups (started_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT SELECT ON backup.base_backups TO fms_app;
    END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS backup.base_backups;
