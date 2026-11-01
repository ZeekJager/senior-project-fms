-- =====================================================================
-- 050_downtime_periods.sql
-- Vehicle downtime: availability, MTBF and MTTR (FMS-131,
-- docs/downtime.md).
--
-- * fleet.downtime_periods: each stretch a vehicle was out of service,
--   with why. A read model, derived from fleet.vehicle_status_history
--   (down while in maintenance or out of service) and the breakdowns of
--   maintenance.failure_events (down from the breakdown until its repair
--   is completed); overlapping stretches are one period. Kept by the
--   fleet.downtime projection and rebuilt from those sources, so it is
--   not audited, except a staff member's reason (reason_override), which
--   survives every rebuild: a period is known by what opened it
--   (opened_by), not by its id.
-- * Read-only views analytics.downtime_facts and
--   analytics.vehicle_service_spans (when each vehicle joined the fleet
--   and was retired), so the analytics module reads its own schema only.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE fleet.downtime_reason AS ENUM
        ('planned_service', 'unplanned_repair', 'breakdown', 'accident', 'awaiting_parts', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fleet.downtime_periods (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id             UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id            BIGINT NOT NULL REFERENCES fleet.vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
    -- What opened it: 'status:<status change public id>', 'failure:<failure public id>', or
    -- 'registered' for a vehicle registered out of service. Its identity across rebuilds.
    opened_by             VARCHAR(80) NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL,
    -- NULL while the vehicle is still out of service.
    ended_at              TIMESTAMPTZ,
    -- From the repair or failure behind it; a staff member's reason, when given, wins.
    derived_reason        fleet.downtime_reason NOT NULL,
    reason_override       fleet.downtime_reason,
    reason                fleet.downtime_reason GENERATED ALWAYS AS (COALESCE(reason_override, derived_reason)) STORED,
    reason_note           VARCHAR(500),
    reason_set_by         BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    reason_set_at         TIMESTAMPTZ,
    -- Public ids, as fleet.vehicle_status_history keeps them: the work order and the failure it belongs to.
    maintenance_record_id UUID,
    failure_event_id      UUID,
    synced_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_downtime_periods_opened UNIQUE (vehicle_id, opened_by),
    CONSTRAINT chk_downtime_periods_order CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT chk_downtime_periods_override CHECK ((reason_override IS NULL) = (reason_set_at IS NULL))
);

-- A vehicle's periods, newest first (GET /vehicles/{id}/downtime, the projection).
CREATE INDEX IF NOT EXISTS idx_downtime_periods_vehicle_time
    ON fleet.downtime_periods (vehicle_id, started_at DESC);

-- The periods touching a month (GET /analytics/downtime).
CREATE INDEX IF NOT EXISTS idx_downtime_periods_time
    ON fleet.downtime_periods (started_at, ended_at);

-- At most one period still open per vehicle.
CREATE UNIQUE INDEX IF NOT EXISTS ux_downtime_periods_open
    ON fleet.downtime_periods (vehicle_id)
    WHERE ended_at IS NULL;

CREATE OR REPLACE VIEW analytics.downtime_facts AS
SELECT p.vehicle_id, p.started_at, p.ended_at, p.reason
FROM fleet.downtime_periods p;

CREATE OR REPLACE VIEW analytics.vehicle_service_spans AS
SELECT
    v.id AS vehicle_id,
    v.created_at AS joined_at,
    (SELECT MIN(h.changed_at) FROM fleet.vehicle_status_history h
      WHERE h.vehicle_id = v.id AND h.to_status = 'retired') AS retired_at
FROM fleet.vehicles v;

-- +migrate Down

DROP VIEW IF EXISTS analytics.vehicle_service_spans;
DROP VIEW IF EXISTS analytics.downtime_facts;
DROP TABLE IF EXISTS fleet.downtime_periods;
DROP TYPE IF EXISTS fleet.downtime_reason;
