-- =====================================================================
-- 056_database_backups.sql
-- Database backups from a screen (FMS-144, docs/backups.md).
--
-- * backup.backups: every backup the app's runner took, scheduled
--   (nightly) or manual (Back up now): when, how big, its SHA-256, who
--   started it, its status and, when it failed, why. The file itself is
--   in the backup storage (never in PostgreSQL, never in the repository),
--   under storage_key; past retention the file is removed and the row
--   kept as expired, so the history stays.
-- * backup.restore_drills: each time a backup was restored into an empty
--   database to prove it restores (npm run backup:restore -- --drill).
-- * backup:read and backup:write, admin only.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS backup;

CREATE TABLE IF NOT EXISTS backup.backups (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    kind             VARCHAR(10)  NOT NULL,
    status           VARCHAR(10)  NOT NULL DEFAULT 'queued',
    database_name    VARCHAR(100) NOT NULL,
    requested_by     BIGINT       REFERENCES auth.users (id) ON DELETE SET NULL,
    requested_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    storage_key      VARCHAR(200),
    size_bytes       BIGINT,
    checksum_sha256  CHAR(64),
    error            TEXT,
    expires_at       TIMESTAMPTZ,
    correlation_id   UUID         NOT NULL,
    CONSTRAINT chk_backup_kind CHECK (kind IN ('scheduled', 'manual')),
    CONSTRAINT chk_backup_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
    -- A finished backup has its file's facts; a failed one says why.
    CONSTRAINT chk_backup_succeeded CHECK (status NOT IN ('succeeded', 'expired') OR (storage_key IS NOT NULL AND size_bytes IS NOT NULL AND checksum_sha256 IS NOT NULL AND finished_at IS NOT NULL)),
    CONSTRAINT chk_backup_failed CHECK (status <> 'failed' OR (error IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_backups_recent ON backup.backups (requested_at DESC);
-- The runner's queue: what is waiting or under way.
CREATE INDEX IF NOT EXISTS idx_backups_pending ON backup.backups (requested_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS backup.restore_drills (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    backup_id        BIGINT       NOT NULL REFERENCES backup.backups (id),
    target_database  VARCHAR(100) NOT NULL,
    status           VARCHAR(10)  NOT NULL,
    started_at       TIMESTAMPTZ  NOT NULL,
    finished_at      TIMESTAMPTZ  NOT NULL,
    tables_restored  INTEGER,
    error            TEXT,
    run_by           VARCHAR(100) NOT NULL,
    CONSTRAINT chk_restore_drill_status CHECK (status IN ('succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_restore_drills_recent ON backup.restore_drills (finished_at DESC);

INSERT INTO auth.permissions (code, description) VALUES
    ('backup:read', 'See database backups and download one'),
    ('backup:write', 'Start a database backup')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM auth.roles r CROSS JOIN auth.permissions p
 WHERE r.name = 'admin' AND p.code IN ('backup:read', 'backup:write')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA backup TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON backup.backups TO fms_app;
        GRANT SELECT, INSERT ON backup.restore_drills TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA backup TO fms_app;
    END IF;
END $$;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code IN ('backup:read', 'backup:write');
DELETE FROM auth.permissions WHERE code IN ('backup:read', 'backup:write');
DROP TABLE IF EXISTS backup.restore_drills;
DROP TABLE IF EXISTS backup.backups;
DROP SCHEMA IF EXISTS backup;
