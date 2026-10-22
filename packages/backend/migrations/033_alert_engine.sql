-- =====================================================================
-- 033_alert_engine.sql
-- Alert engine (FMS-92): what turning events into alerts that are
-- de-duplicated, scoped, acknowledged, resolved and escalated needs from
-- the alert tables of 008.
--
-- - depot_id: whose alert it is (depot scope for GET /alerts and the
--   socket rooms); null for an alert no depot owns (the fleet's).
-- - trip_id, entity_type, entity_id: what it is about. entity_id is that
--   record's public id (a vehicle, driver, document, trip ...), so a
--   response needs no other module's table.
-- - dedup_key, occurrence_count, last_occurred_at: a repeat of the same
--   source within the rule's window updates the active alert instead of
--   opening another.
-- - escalation_level, escalated_at: a critical alert left unacknowledged
--   is escalated to the next tier of recipients by a scheduled job.
-- - acknowledged_by, resolved_by: who; alert_acknowledgements keeps the
--   history with comments.
-- =====================================================================

-- +migrate Up

ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS depot_id BIGINT REFERENCES fleet.depots(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS trip_id BIGINT REFERENCES trip.trips(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS entity_type VARCHAR(30);
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS source_event_id UUID;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS dedup_key VARCHAR(255);
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS escalation_level SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS acknowledged_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS resolved_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE alert.alerts ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$ BEGIN
    ALTER TABLE alert.alerts ADD CONSTRAINT chk_alert_occurrences CHECK (occurrence_count >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE alert.alerts ADD CONSTRAINT chk_alert_escalation CHECK (escalation_level >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE alert.alerts ADD CONSTRAINT chk_alert_details CHECK (jsonb_typeof(details) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The active alert of a source, for de-duplication.
CREATE INDEX IF NOT EXISTS idx_alerts_dedup_active
    ON alert.alerts(dedup_key, last_occurred_at DESC)
    WHERE status IN ('open', 'acknowledged');

-- A depot's alerts, newest first (GET /alerts).
CREATE INDEX IF NOT EXISTS idx_alerts_depot_time
    ON alert.alerts(depot_id, created_at DESC);

-- Critical alerts nobody has acknowledged yet (the escalation job).
CREATE INDEX IF NOT EXISTS idx_alerts_escalation_due
    ON alert.alerts(created_at)
    WHERE status = 'open' AND severity = 'critical';

-- +migrate Down

DROP INDEX IF EXISTS alert.idx_alerts_escalation_due;
DROP INDEX IF EXISTS alert.idx_alerts_depot_time;
DROP INDEX IF EXISTS alert.idx_alerts_dedup_active;
ALTER TABLE IF EXISTS alert.alerts DROP CONSTRAINT IF EXISTS chk_alert_details;
ALTER TABLE IF EXISTS alert.alerts DROP CONSTRAINT IF EXISTS chk_alert_escalation;
ALTER TABLE IF EXISTS alert.alerts DROP CONSTRAINT IF EXISTS chk_alert_occurrences;
ALTER TABLE IF EXISTS alert.alerts
    DROP COLUMN IF EXISTS details,
    DROP COLUMN IF EXISTS resolved_by,
    DROP COLUMN IF EXISTS acknowledged_by,
    DROP COLUMN IF EXISTS escalated_at,
    DROP COLUMN IF EXISTS escalation_level,
    DROP COLUMN IF EXISTS last_occurred_at,
    DROP COLUMN IF EXISTS occurrence_count,
    DROP COLUMN IF EXISTS dedup_key,
    DROP COLUMN IF EXISTS source_event_id,
    DROP COLUMN IF EXISTS entity_id,
    DROP COLUMN IF EXISTS entity_type,
    DROP COLUMN IF EXISTS trip_id,
    DROP COLUMN IF EXISTS depot_id;
