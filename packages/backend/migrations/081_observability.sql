-- =====================================================================
-- 081_observability.sql
-- Observability (FMS-109, FMS-163, docs/observability.md).
--
-- * system.maintenance_windows: hosts whose monitoring alerts are held
--   between two times, with a reason; their start and end are written to
--   the audit log when they happen (started_at_recorded, ended_recorded).
-- * alert.channel_posts: an alert posted to a channel with no recipient
--   (a Microsoft Teams channel): when it opened and when it resolved,
--   each sent once by the channel-post job, with its attempts.
-- * The monitoring thresholds (warning and critical per metric) as
--   settings, in the category Monitoring; Prometheus' rules compare
--   against them as the API exports them.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS system.maintenance_windows (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    -- The hosts it silences: the `host` label of the monitoring alerts (node, container or service names).
    hosts               TEXT[]       NOT NULL,
    starts_at           TIMESTAMPTZ  NOT NULL,
    ends_at             TIMESTAMPTZ  NOT NULL,
    reason              VARCHAR(500) NOT NULL,
    created_by          BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    cancelled_at        TIMESTAMPTZ,
    cancelled_by        BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    -- When the job wrote its start and its end to the audit log.
    start_recorded_at   TIMESTAMPTZ,
    end_recorded_at     TIMESTAMPTZ,
    -- Alerts it held back.
    suppressed_count    INTEGER      NOT NULL DEFAULT 0,
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version             INTEGER      NOT NULL DEFAULT 1,
    CONSTRAINT chk_maintenance_hosts CHECK (cardinality(hosts) BETWEEN 1 AND 50),
    CONSTRAINT chk_maintenance_times CHECK (ends_at > starts_at),
    CONSTRAINT chk_maintenance_reason CHECK (char_length(reason) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_times ON system.maintenance_windows (starts_at, ends_at) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_maintenance_windows_updated_at
    BEFORE UPDATE ON system.maintenance_windows
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_maintenance_windows_version
    BEFORE UPDATE ON system.maintenance_windows
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE TABLE IF NOT EXISTS alert.channel_posts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    alert_id         BIGINT        NOT NULL REFERENCES alert.alerts(id) ON DELETE CASCADE ON UPDATE CASCADE,
    channel          VARCHAR(20)   NOT NULL,
    kind             VARCHAR(10)   NOT NULL,
    status           VARCHAR(10)   NOT NULL DEFAULT 'queued',
    attempts         SMALLINT      NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error       VARCHAR(500),
    provider_id      BIGINT        REFERENCES integration.external_providers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    sent_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_channel_post_channel CHECK (channel IN ('teams')),
    CONSTRAINT chk_channel_post_kind CHECK (kind IN ('opened', 'resolved')),
    CONSTRAINT chk_channel_post_status CHECK (status IN ('queued', 'sent', 'failed')),
    CONSTRAINT ux_channel_post UNIQUE (alert_id, channel, kind)
);

CREATE INDEX IF NOT EXISTS idx_channel_posts_due ON alert.channel_posts (next_attempt_at) WHERE status = 'queued';

INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('monitor_cpu_warning_pct', 'CPU warning', 'Monitoring',
     'A host or container using more CPU than this for 5 minutes is a warning.',
     'integer', '75', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_cpu_critical_pct', 'CPU critical', 'Monitoring',
     'A host or container using more CPU than this for 5 minutes is critical.',
     'integer', '90', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_memory_warning_pct', 'Memory warning', 'Monitoring',
     'Memory in use above this for 5 minutes is a warning.',
     'integer', '80', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_memory_critical_pct', 'Memory critical', 'Monitoring',
     'Memory in use above this for 5 minutes is critical.',
     'integer', '90', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_disk_warning_pct', 'Disk warning', 'Monitoring',
     'A disk fuller than this for 10 minutes is a warning; one to be full within 7 days is too.',
     'integer', '75', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_disk_critical_pct', 'Disk critical', 'Monitoring',
     'A disk fuller than this for 10 minutes is critical.',
     'integer', '90', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_db_connections_warning_pct', 'Database connections warning', 'Monitoring',
     'Database connections in use, as a share of the most allowed, above this for 5 minutes is a warning.',
     'integer', '70', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_db_connections_critical_pct', 'Database connections critical', 'Monitoring',
     'Database connections in use above this share for 5 minutes is critical.',
     'integer', '85', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_replica_lag_warning_seconds', 'Replica lag warning', 'Monitoring',
     'The standby this many seconds behind the primary for 2 minutes is a warning.',
     'integer', '30', '{"min": 1, "max": 3600, "unit": "seconds"}', TRUE, 'settings'),
    ('monitor_replica_lag_critical_seconds', 'Replica lag critical', 'Monitoring',
     'The standby this many seconds behind the primary for 2 minutes is critical.',
     'integer', '60', '{"min": 1, "max": 3600, "unit": "seconds"}', TRUE, 'settings'),
    ('monitor_error_rate_warning_pct', 'Server errors warning', 'Monitoring',
     'API answers that are 5xx above this share for 5 minutes is a warning.',
     'integer', '2', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_error_rate_critical_pct', 'Server errors critical', 'Monitoring',
     'API answers that are 5xx above this share for 5 minutes is critical.',
     'integer', '5', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('monitor_p95_warning_ms', 'Latency warning', 'Monitoring',
     'The API p95 latency above this for 5 minutes is a warning (the CFG-3 budget).',
     'integer', '500', '{"min": 50, "max": 60000, "unit": "ms"}', TRUE, 'settings'),
    ('monitor_p95_critical_ms', 'Latency critical', 'Monitoring',
     'The API p95 latency above this for 5 minutes is critical.',
     'integer', '1000', '{"min": 50, "max": 60000, "unit": "ms"}', TRUE, 'settings'),
    ('monitor_gps_silence_minutes', 'GPS silence', 'Monitoring',
     'No GPS point stored for this many minutes while trips are under way is critical.',
     'integer', '2', '{"min": 1, "max": 60, "unit": "minutes"}', TRUE, 'settings')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT SELECT, INSERT, UPDATE ON system.maintenance_windows TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON alert.channel_posts TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA system TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA alert TO fms_app;
    END IF;
END $$;

-- +migrate Down

DELETE FROM settings.settings WHERE key IN ('monitor_cpu_warning_pct', 'monitor_cpu_critical_pct', 'monitor_memory_warning_pct', 'monitor_memory_critical_pct', 'monitor_disk_warning_pct', 'monitor_disk_critical_pct', 'monitor_db_connections_warning_pct', 'monitor_db_connections_critical_pct', 'monitor_replica_lag_warning_seconds', 'monitor_replica_lag_critical_seconds', 'monitor_error_rate_warning_pct', 'monitor_error_rate_critical_pct', 'monitor_p95_warning_ms', 'monitor_p95_critical_ms', 'monitor_gps_silence_minutes');
DELETE FROM settings.definitions WHERE key IN ('monitor_cpu_warning_pct', 'monitor_cpu_critical_pct', 'monitor_memory_warning_pct', 'monitor_memory_critical_pct', 'monitor_disk_warning_pct', 'monitor_disk_critical_pct', 'monitor_db_connections_warning_pct', 'monitor_db_connections_critical_pct', 'monitor_replica_lag_warning_seconds', 'monitor_replica_lag_critical_seconds', 'monitor_error_rate_warning_pct', 'monitor_error_rate_critical_pct', 'monitor_p95_warning_ms', 'monitor_p95_critical_ms', 'monitor_gps_silence_minutes');
DROP TABLE IF EXISTS alert.channel_posts;
DROP TABLE IF EXISTS system.maintenance_windows;
