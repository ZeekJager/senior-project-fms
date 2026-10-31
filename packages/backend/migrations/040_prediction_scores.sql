-- =====================================================================
-- 040_prediction_scores.sql
-- What the nightly scoring (FMS-55) stores with each prediction, beyond
-- the risk score 005 already holds.
--
-- * maintenance_predictions: the health score (round((1 - p) * 100)), its
--   risk level (low, medium, high, from the ML service), the inputs that
--   raise the vehicle's risk most (factors, at most 3, for the health
--   score screen, FMS-56) and the scoring time t the inputs were computed
--   as of. A row from before this migration has none of them; a scored
--   row has all four.
-- * One prediction per vehicle, type, scoring time and model, so a run
--   retried the same day does not store a vehicle twice.
-- =====================================================================

-- +migrate Up

ALTER TABLE maintenance.maintenance_predictions
    ADD COLUMN IF NOT EXISTS health_score SMALLINT,
    ADD COLUMN IF NOT EXISTS risk_level   VARCHAR(10),
    ADD COLUMN IF NOT EXISTS factors      JSONB,
    ADD COLUMN IF NOT EXISTS as_of        TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_predictions
        ADD CONSTRAINT chk_prediction_health_score CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100),
        ADD CONSTRAINT chk_prediction_risk_level CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
        ADD CONSTRAINT chk_prediction_factors
            CHECK (factors IS NULL OR (jsonb_typeof(factors) = 'array' AND jsonb_array_length(factors) <= 3)),
        ADD CONSTRAINT chk_prediction_scored
            CHECK ((health_score IS NULL) = (risk_level IS NULL)
               AND (health_score IS NULL) = (factors IS NULL)
               AND (health_score IS NULL) = (as_of IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_predictions_scoring
    ON maintenance.maintenance_predictions(vehicle_id, prediction_type, as_of, model_name, model_version)
    WHERE as_of IS NOT NULL;

-- +migrate Down

DROP INDEX IF EXISTS maintenance.ux_predictions_scoring;
ALTER TABLE IF EXISTS maintenance.maintenance_predictions
    DROP CONSTRAINT IF EXISTS chk_prediction_scored,
    DROP CONSTRAINT IF EXISTS chk_prediction_factors,
    DROP CONSTRAINT IF EXISTS chk_prediction_risk_level,
    DROP CONSTRAINT IF EXISTS chk_prediction_health_score,
    DROP COLUMN IF EXISTS as_of,
    DROP COLUMN IF EXISTS factors,
    DROP COLUMN IF EXISTS risk_level,
    DROP COLUMN IF EXISTS health_score;
