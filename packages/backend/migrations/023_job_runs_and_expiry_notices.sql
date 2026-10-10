-- =====================================================================
-- 023_job_runs_and_expiry_notices.sql
-- Job scheduler and expiry checks (FMS-26).
--
-- jobs.job_runs: one row per job per run key (a local day for daily
-- jobs). Inserting the row is the lock: with several app instances only
-- one wins the (job_name, run_key) pair, and the row is the run history.
-- A failed run, or one whose lease ran out (the instance died), may be
-- taken again. Platform-owned (src/shared/jobs), like the api schema.
--
-- fleet.expiry_notices: each expiry warning raised, once per subject,
-- expiry date and level. A re-run of the daily check, a missed day or the
-- check on DocumentUploaded never raises the same warning twice; a new
-- expiry date (a renewed licence, a replaced document) starts afresh.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS jobs;

CREATE TABLE IF NOT EXISTS jobs.job_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_name        VARCHAR(100) NOT NULL,
    run_key         VARCHAR(100) NOT NULL,
    status          VARCHAR(20)  NOT NULL,
    instance_id     VARCHAR(200) NOT NULL,
    correlation_id  UUID         NOT NULL,
    attempts        INTEGER      NOT NULL DEFAULT 1,
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_until     TIMESTAMPTZ  NOT NULL,
    finished_at     TIMESTAMPTZ,
    result          JSONB,
    error           TEXT,
    CONSTRAINT uq_job_runs_job_key UNIQUE (job_name, run_key),
    CONSTRAINT chk_job_run_status CHECK (status IN ('running', 'succeeded', 'failed')),
    CONSTRAINT chk_job_run_attempts CHECK (attempts >= 1),
    CONSTRAINT chk_job_run_result CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_job_runs_recent ON jobs.job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS fleet.expiry_notices (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_type    VARCHAR(20) NOT NULL,
    subject_id      BIGINT      NOT NULL,
    expires_on      DATE        NOT NULL,
    level           VARCHAR(10) NOT NULL,
    days_left       INTEGER     NOT NULL,
    correlation_id  UUID        NOT NULL,
    notified_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_expiry_notice UNIQUE (subject_type, subject_id, expires_on, level),
    CONSTRAINT chk_expiry_notice_subject CHECK (subject_type IN ('document', 'licence')),
    CONSTRAINT chk_expiry_notice_level CHECK (level IN ('amber', 'red'))
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA jobs TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON jobs.job_runs TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA jobs TO fms_app;
    END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS fleet.expiry_notices;
DROP TABLE IF EXISTS jobs.job_runs;
DROP SCHEMA IF EXISTS jobs;
