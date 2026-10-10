-- =====================================================================
-- 024_audit_source_and_result.sql
-- Audit coverage (FMS-27): every audit row records where the action came
-- from and how it ended (architecture §14.2).
--
-- request_source: {"channel": "web" | "pwa" | "job" | "webhook" | "script",
--   "ip", "user_agent"} for requests; {"channel": "job", "actor": "system",
--   "job": <name>} for scheduled jobs.
-- result: success, denied (refused by a rule: permission, throttle, token
--   reuse) or failed (attempted and did not work: wrong password, job error).
--
-- The table stays append-only (010's triggers are untouched). Rows written
-- before this migration keep NULL in both columns: they cannot be updated,
-- and their result is not known. The checks are NOT VALID so they hold for
-- every new row without touching old ones.
-- =====================================================================

-- +migrate Up

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

-- +migrate Down

DROP INDEX IF EXISTS audit.idx_audit_logs_not_success;
ALTER TABLE audit.audit_logs DROP CONSTRAINT IF EXISTS chk_audit_request_source;
ALTER TABLE audit.audit_logs DROP CONSTRAINT IF EXISTS chk_audit_result;
ALTER TABLE audit.audit_logs DROP COLUMN IF EXISTS result;
ALTER TABLE audit.audit_logs DROP COLUMN IF EXISTS request_source;
