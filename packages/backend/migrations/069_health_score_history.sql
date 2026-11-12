-- =====================================================================
-- 069_health_score_history.sql
-- The fleet-wide health score trend (FMS-150, docs/vehicle-health.md):
-- every health score the nightly batch stored (FMS-55), so the analytics
-- module reads analytics.* only.
--
-- * health_score_history: each scored prediction, active or superseded
--   by a later night's, with when it was scored as of. A night's score is
--   never recomputed: the trend reads what was stored.
-- =====================================================================

-- +migrate Up

CREATE OR REPLACE VIEW analytics.health_score_history AS
SELECT
    p.vehicle_id,
    p.prediction_type,
    p.health_score,
    p.risk_level,
    p.as_of
FROM maintenance.maintenance_predictions p
WHERE p.health_score IS NOT NULL;

-- +migrate Down

DROP VIEW IF EXISTS analytics.health_score_history;
