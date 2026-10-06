-- =====================================================================
-- 008_alerts_incidents.sql
-- Architecture boundary: alert.*
-- Alert persistence is independent from notification delivery.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS alert;
REVOKE CREATE ON SCHEMA alert FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE alert.alert_severity AS ENUM
        ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert.alert_status AS ENUM
        ('open', 'acknowledged', 'resolved', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert.notification_channel AS ENUM
        ('in_app', 'push', 'sms', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert.notification_status AS ENUM
        ('queued', 'sent', 'delivered', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS alert.alerts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id        BIGINT REFERENCES fleet.vehicles(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    driver_id         BIGINT REFERENCES fleet.drivers(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    alert_type        VARCHAR(100) NOT NULL,
    severity          alert.alert_severity NOT NULL DEFAULT 'medium',
    source_module     VARCHAR(50) NOT NULL,
    source_event_type VARCHAR(100),
    source_record_id  BIGINT,
    title             VARCHAR(255) NOT NULL,
    description       TEXT,
    status            alert.alert_status NOT NULL DEFAULT 'open',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at   TIMESTAMPTZ,
    resolved_at       TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_alert_ack_time
        CHECK (acknowledged_at IS NULL OR acknowledged_at >= created_at),
    CONSTRAINT chk_alert_resolve_time
        CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE TABLE IF NOT EXISTS alert.alert_acknowledgements (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id        BIGINT NOT NULL REFERENCES alert.alerts(id)
                    ON DELETE CASCADE ON UPDATE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES auth.users(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    action          VARCHAR(30) NOT NULL,
    comment         TEXT,
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_alert_ack_action
        CHECK (action IN ('acknowledge', 'resolve', 'dismiss', 'comment'))
);

-- One row per recipient per channel. Doubles as the in-app inbox (S-17):
-- an 'in_app' row is the inbox entry and read_at marks it read. Not every
-- notification comes from an alert (e.g. "trip assigned"), so alert_id
-- is optional and the content lives on the row itself.
CREATE TABLE IF NOT EXISTS alert.notifications (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id             BIGINT REFERENCES alert.alerts(id)
                         ON DELETE CASCADE ON UPDATE CASCADE,
    recipient_user_id    BIGINT NOT NULL REFERENCES auth.users(id)
                         ON DELETE RESTRICT ON UPDATE CASCADE,
    provider_id          BIGINT REFERENCES integration.external_providers(id)
                         ON DELETE SET NULL ON UPDATE CASCADE,
    notification_type    VARCHAR(50) NOT NULL,
    title                VARCHAR(255) NOT NULL,
    message              TEXT NOT NULL,
    read_at              TIMESTAMPTZ,
    channel              alert.notification_channel NOT NULL,
    status               alert.notification_status NOT NULL DEFAULT 'queued',
    provider_message_id  VARCHAR(255),
    delivery_attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
    queued_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at              TIMESTAMPTZ,
    delivered_at         TIMESTAMPTZ,
    failed_at            TIMESTAMPTZ,
    failure_reason       TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_notification_read_in_app
        CHECK (read_at IS NULL OR channel = 'in_app')
);

CREATE TABLE IF NOT EXISTS alert.incident_reports (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id      BIGINT REFERENCES fleet.vehicles(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    driver_id       BIGINT REFERENCES fleet.drivers(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    trip_id         BIGINT REFERENCES trip.trips(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    reported_by     BIGINT NOT NULL REFERENCES auth.users(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    incident_type   VARCHAR(100) NOT NULL,
    severity        alert.alert_severity NOT NULL DEFAULT 'medium',
    description     TEXT NOT NULL,
    latitude        NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude       NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    occurred_at     TIMESTAMPTZ NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'open',
    attachments     JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_incident_status
        CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
    CONSTRAINT chk_incident_attachments
        CHECK (jsonb_typeof(attachments) = 'array')
);

CREATE OR REPLACE TRIGGER trg_alert_alerts_updated_at
    BEFORE UPDATE ON alert.alerts
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_alert_notifications_updated_at
    BEFORE UPDATE ON alert.notifications
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_alert_incidents_updated_at
    BEFORE UPDATE ON alert.incident_reports
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TABLE IF EXISTS alert.incident_reports;
DROP TABLE IF EXISTS alert.notifications;
DROP TABLE IF EXISTS alert.alert_acknowledgements;
DROP TABLE IF EXISTS alert.alerts;
DROP TYPE IF EXISTS alert.notification_status;
DROP TYPE IF EXISTS alert.notification_channel;
DROP TYPE IF EXISTS alert.alert_status;
DROP TYPE IF EXISTS alert.alert_severity;
DROP SCHEMA IF EXISTS alert;
