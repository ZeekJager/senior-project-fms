-- =====================================================================
-- 035_telemetry_rules.sql
-- The telemetry rules (FMS-46): speeding and idling flags raised from the
-- GPS stream into tracking.telemetry_flags (007).
--
-- - tracking.rule_thresholds: the rules' thresholds (CFG-3). One row for
--   the whole fleet (depot_id NULL) and one per depot that differs. The
--   fleet row starts at speeding over 80 km/h for 3 pings, cleared by 3
--   pings at or under it, and idling after 5 minutes at 0 km/h.
-- - One flag of each type per vehicle while its condition lasts
--   (resolved_at IS NULL), so a rule that runs twice cannot open a second.
--   Older duplicates, if any, are closed first, at the newer one's start.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS tracking.rule_thresholds (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- NULL: the whole fleet's thresholds; a depot's row overrides them.
    depot_id           BIGINT REFERENCES fleet.depots(id)
                       ON DELETE CASCADE ON UPDATE CASCADE,
    speed_limit_kmh    SMALLINT NOT NULL DEFAULT 80,
    -- Consecutive pings over the limit that raise a speeding flag.
    speeding_pings     SMALLINT NOT NULL DEFAULT 3,
    -- Consecutive pings at or under the limit that resolve it.
    clear_pings        SMALLINT NOT NULL DEFAULT 3,
    -- Minutes at 0 km/h, engine not reported off, that raise an idling flag.
    idle_minutes       SMALLINT NOT NULL DEFAULT 5,
    updated_by         BIGINT REFERENCES auth.users(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_rule_thresholds_depot UNIQUE NULLS NOT DISTINCT (depot_id),
    CONSTRAINT chk_rule_speed_limit CHECK (speed_limit_kmh BETWEEN 20 AND 200),
    CONSTRAINT chk_rule_speeding_pings CHECK (speeding_pings BETWEEN 1 AND 20),
    CONSTRAINT chk_rule_clear_pings CHECK (clear_pings BETWEEN 1 AND 20),
    CONSTRAINT chk_rule_idle_minutes CHECK (idle_minutes BETWEEN 1 AND 120)
);

CREATE OR REPLACE TRIGGER trg_tracking_rule_thresholds_updated_at
    BEFORE UPDATE ON tracking.rule_thresholds
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

INSERT INTO tracking.rule_thresholds (depot_id) VALUES (NULL)
    ON CONFLICT ON CONSTRAINT ux_rule_thresholds_depot DO NOTHING;

UPDATE tracking.telemetry_flags f
   SET resolved_at = d.newest_observed_at
  FROM (SELECT id,
               first_value(observed_at) OVER w AS newest_observed_at,
               row_number() OVER w AS rn
          FROM tracking.telemetry_flags
         WHERE resolved_at IS NULL
        WINDOW w AS (PARTITION BY vehicle_id, flag_type ORDER BY observed_at DESC, id DESC)) d
 WHERE f.id = d.id AND d.rn > 1;

-- The flag of a type a vehicle has while its condition lasts: at most one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_telemetry_flags_ongoing
    ON tracking.telemetry_flags(vehicle_id, flag_type)
    WHERE resolved_at IS NULL;

-- +migrate Down

DROP INDEX IF EXISTS tracking.ux_telemetry_flags_ongoing;
DROP TABLE IF EXISTS tracking.rule_thresholds;
