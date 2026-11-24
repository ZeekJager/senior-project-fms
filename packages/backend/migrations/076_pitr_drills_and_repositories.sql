-- =====================================================================
-- 076_pitr_drills_and_repositories.sql
-- Point-in-time recovery monitoring and drills (FMS-108, ADR-07,
-- docs/backups.md#continuous-archiving-and-point-in-time-recovery).
--
-- * backup.restore_drills takes point-in-time drills beside the dump ones
--   (FMS-144): `method` is `dump` (a pg_dump file restored into a new
--   database, backup_id names it) or `pitr` (the latest base backup plus
--   the archived WAL replayed to a restore point, into a scratch instance
--   in the database container; base_backup_label names the base backup).
--   A pitr drill records its recovery target, the time from the start of
--   the restore to the database opening (rto_seconds), and, per key table,
--   the rows and checksum of the live database at the restore point and of
--   the copy (checks).
-- * backup.base_backups.repo_key: the repository a base backup went to
--   (pgBackRest backs up to one at a time).
-- * backup.pitr_repositories: each pgBackRest repository (1 on this
--   server, 2 off site) as the database container's status loop last saw
--   it, once a minute: its status and since when, the archived WAL range, when the newest
--   segment arrived, and its base backups. The API reads it for the
--   Backups screen ("Recoverable from ... to ..."), System health and the
--   backup alerts; only the container, as the schema owner, writes it.
-- =====================================================================

-- +migrate Up

ALTER TABLE backup.restore_drills ALTER COLUMN backup_id DROP NOT NULL;
ALTER TABLE backup.restore_drills
    ADD COLUMN IF NOT EXISTS method            VARCHAR(4)  NOT NULL DEFAULT 'dump',
    ADD COLUMN IF NOT EXISTS base_backup_label VARCHAR(60),
    ADD COLUMN IF NOT EXISTS recovery_target   TEXT,
    ADD COLUMN IF NOT EXISTS rto_seconds       INTEGER,
    ADD COLUMN IF NOT EXISTS checks            JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_restore_drill_method') THEN
        ALTER TABLE backup.restore_drills
            ADD CONSTRAINT chk_restore_drill_method CHECK (method IN ('dump', 'pitr')),
            ADD CONSTRAINT chk_restore_drill_source CHECK (
                (method = 'dump' AND backup_id IS NOT NULL) OR (method = 'pitr' AND base_backup_label IS NOT NULL)),
            ADD CONSTRAINT chk_restore_drill_rto CHECK (rto_seconds IS NULL OR rto_seconds >= 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_restore_drills_method_recent ON backup.restore_drills (method, finished_at DESC);

-- pgBackRest backs up to one repository at a time: each base backup names the one it went to.
ALTER TABLE backup.base_backups ADD COLUMN IF NOT EXISTS repo_key SMALLINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS backup.pitr_repositories (
    repo_key             SMALLINT     PRIMARY KEY,
    cipher               VARCHAR(20),
    status_code          INTEGER      NOT NULL,
    status_message       TEXT         NOT NULL,
    -- When status_code last changed: how long a repository has been unreachable.
    status_since         TIMESTAMPTZ  NOT NULL,
    archive_min          VARCHAR(24),
    archive_max          VARCHAR(24),
    archive_max_seen_at  TIMESTAMPTZ,
    backups              INTEGER      NOT NULL DEFAULT 0,
    oldest_backup_at     TIMESTAMPTZ,
    newest_backup_at     TIMESTAMPTZ,
    checked_at           TIMESTAMPTZ  NOT NULL,
    CONSTRAINT chk_pitr_repo_key CHECK (repo_key BETWEEN 1 AND 256)
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT SELECT ON backup.pitr_repositories TO fms_app;
    END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS backup.pitr_repositories;
ALTER TABLE backup.base_backups DROP COLUMN IF EXISTS repo_key;
DROP INDEX IF EXISTS backup.idx_restore_drills_method_recent;
DELETE FROM backup.restore_drills WHERE method = 'pitr';
ALTER TABLE backup.restore_drills
    DROP CONSTRAINT IF EXISTS chk_restore_drill_rto,
    DROP CONSTRAINT IF EXISTS chk_restore_drill_source,
    DROP CONSTRAINT IF EXISTS chk_restore_drill_method,
    DROP COLUMN IF EXISTS checks,
    DROP COLUMN IF EXISTS rto_seconds,
    DROP COLUMN IF EXISTS recovery_target,
    DROP COLUMN IF EXISTS base_backup_label,
    DROP COLUMN IF EXISTS method;
ALTER TABLE backup.restore_drills ALTER COLUMN backup_id SET NOT NULL;
