-- =====================================================================
-- 059_system_health.sql
-- System health (FMS-143, docs/system-health.md).
--
-- * system.health_samples: once a minute each API instance checks the
--   API itself, the database, the read replica, Redis, the AI service
--   and each active provider's circuit, and records ok, down (with its
--   error) or disabled (not configured), with the check's latency. One
--   row per component and minute: when instances disagree, down wins.
--   A minute with no row is no data (no instance was running to check).
-- * system.request_rollups: per minute, how many API requests were
--   answered, how many with a 5xx, and their latencies as a histogram
--   (so instances add up and a p95 can be read across them). Counts
--   only: no paths, bodies, users or ids.
-- * Both kept 30 days (system-health-retention, daily).
-- * system:read, admin only.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS system;

CREATE TABLE IF NOT EXISTS system.health_samples (
    component   VARCHAR(80)  NOT NULL,
    minute      TIMESTAMPTZ  NOT NULL,
    label       VARCHAR(100) NOT NULL,
    status      VARCHAR(10)  NOT NULL,
    latency_ms  INTEGER,
    error       VARCHAR(300),
    PRIMARY KEY (component, minute),
    CONSTRAINT chk_health_sample_status CHECK (status IN ('ok', 'down', 'disabled')),
    CONSTRAINT chk_health_sample_latency CHECK (latency_ms IS NULL OR latency_ms >= 0),
    -- A component that was down says why.
    CONSTRAINT chk_health_sample_error CHECK (status <> 'down' OR error IS NOT NULL)
);

-- Retention, and the API's own samples (the first one is where the history starts).
CREATE INDEX IF NOT EXISTS idx_health_samples_minute ON system.health_samples (minute);

CREATE TABLE IF NOT EXISTS system.request_rollups (
    minute           TIMESTAMPTZ PRIMARY KEY,
    requests         INTEGER     NOT NULL,
    errors_5xx       INTEGER     NOT NULL,
    -- Requests per latency bucket; the bounds are the API's (REQUEST_LATENCY_BUCKETS_MS), the last one open.
    latency_buckets  INTEGER[]   NOT NULL,
    CONSTRAINT chk_request_rollup_counts CHECK (requests >= 0 AND errors_5xx >= 0 AND errors_5xx <= requests)
);

INSERT INTO auth.permissions (code, description) VALUES
    ('system:read', 'See the health of the system: uptime, outages, failed jobs and request errors')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM auth.roles r CROSS JOIN auth.permissions p
 WHERE r.name = 'admin' AND p.code = 'system:read'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA system TO fms_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON system.health_samples, system.request_rollups TO fms_app;
    END IF;
END $$;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'system:read';
DELETE FROM auth.permissions WHERE code = 'system:read';
DROP TABLE IF EXISTS system.request_rollups;
DROP TABLE IF EXISTS system.health_samples;
DROP SCHEMA IF EXISTS system;
