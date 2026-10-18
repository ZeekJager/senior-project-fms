-- =====================================================================
-- 026_domain_event_outbox.sql
-- Domain events: transactional outbox and consumer idempotency (FMS-73).
--
-- events.outbox: every domain event, written by the module in the same
-- transaction as the change it describes, so a rolled-back change leaves
-- no event and a committed one cannot lose its event. The relay
-- (src/shared/events/outbox-relay.ts) delivers each row twice over:
--   dispatched_at  the in-process consumers have handled it (in order
--                  per aggregate_key; retried with backoff, given up on
--                  with dead_lettered_at after the last attempt);
--   published_at   it is on Redis pub/sub for the real-time layer (or
--                  Redis is not configured), in outbox order.
-- event_id is unique: a job that publishes the same fact twice (a fixed
-- id from deterministicEventId) writes one row.
--
-- events.processed_events: (consumer, event_id) for each event a consumer
-- has handled, inserted in the consumer's transaction, so a redelivered
-- event is handled once.
--
-- Platform-owned (src/shared/events), like the api and jobs schemas, not
-- in `shared`, whose types and functions every module may use. Modules
-- write through eventBus.publish and never query these tables.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS events;
REVOKE CREATE ON SCHEMA events FROM PUBLIC;

CREATE TABLE IF NOT EXISTS events.outbox (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          UUID         NOT NULL,
    event_type        VARCHAR(100) NOT NULL,
    event_version     SMALLINT     NOT NULL DEFAULT 1,
    occurred_at       TIMESTAMPTZ  NOT NULL,
    actor_id          UUID,
    correlation_id    UUID         NOT NULL,
    payload           JSONB        NOT NULL,
    aggregate_key     VARCHAR(200),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    dispatched_at     TIMESTAMPTZ,
    published_at      TIMESTAMPTZ,
    attempts          INTEGER      NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ,
    last_error        TEXT,
    dead_lettered_at  TIMESTAMPTZ,
    CONSTRAINT uq_outbox_event_id UNIQUE (event_id),
    CONSTRAINT chk_outbox_event_type CHECK (event_type ~ '^[A-Z][A-Za-z0-9]*$'),
    CONSTRAINT chk_outbox_event_version CHECK (event_version >= 1),
    CONSTRAINT chk_outbox_payload CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_outbox_dead_letter CHECK (dead_lettered_at IS NULL OR dispatched_at IS NULL)
);

-- What the relay still has to dispatch, oldest first, and (for the order
-- per aggregate) whether an older event of the same aggregate is waiting.
CREATE INDEX IF NOT EXISTS idx_outbox_undispatched
    ON events.outbox (id) WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_undispatched_aggregate
    ON events.outbox (aggregate_key, id) WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL AND aggregate_key IS NOT NULL;
-- What it still has to put on Redis.
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON events.outbox (id) WHERE published_at IS NULL;
-- Dead letters, for the lag report.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
    ON events.outbox (id) WHERE dead_lettered_at IS NOT NULL;
-- The daily clean-up of delivered rows.
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON events.outbox (created_at);

CREATE TABLE IF NOT EXISTS events.processed_events (
    consumer      VARCHAR(100) NOT NULL,
    event_id      UUID         NOT NULL,
    processed_at  TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_processed_events PRIMARY KEY (consumer, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_at ON events.processed_events (processed_at);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA events TO fms_app;
        -- DELETE: only the daily clean-up of delivered rows.
        GRANT SELECT, INSERT, UPDATE, DELETE ON events.outbox TO fms_app;
        GRANT SELECT, INSERT, DELETE ON events.processed_events TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA events TO fms_app;
    END IF;
END $$;

-- +migrate Down

DROP TABLE IF EXISTS events.processed_events;
DROP TABLE IF EXISTS events.outbox;
DROP SCHEMA IF EXISTS events;
