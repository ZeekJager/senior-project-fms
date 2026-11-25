-- =====================================================================
-- 078_job_runs_delete.sql
-- The daily job-runs-cleanup (src/shared/jobs/job-runs-cleanup.ts)
-- deletes interval jobs' runs older than a week, as the app role. Migration
-- 023 granted fms_app only SELECT, INSERT and UPDATE on jobs.job_runs, so
-- the job failed every day with "permission denied for table job_runs" and
-- no run was ever removed (SE-207). The first run after this deletes the
-- backlog in one statement: a minute job writes 1,440 rows a day, small
-- next to the outbox.
-- =====================================================================

-- +migrate Up

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT DELETE ON jobs.job_runs TO fms_app;
    END IF;
END $$;

-- +migrate Down

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        REVOKE DELETE ON jobs.job_runs FROM fms_app;
    END IF;
END $$;
