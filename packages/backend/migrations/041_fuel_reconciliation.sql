-- =====================================================================
-- 041_fuel_reconciliation.sql
-- Fuel reconciliation (FMS-41): a month's fuel bought against what the
-- vehicle's trips needed. A vehicle outside the threshold gets an anomaly
-- about the period, not about one fill-up.
--
-- * fuel_anomalies.fuel_log_id becomes optional: a per-event anomaly
--   (FMS-82) names its fill-up; a reconciliation anomaly names its period
--   (period_start, period_end) with the figures it was judged on: the
--   distance of the completed trips (km), the fuel they needed at the
--   vehicle's rated efficiency and the fuel logged (ml, integers).
-- * One reconciliation anomaly per vehicle and period, so a job that
--   reconciles the same month again adds nothing.
-- =====================================================================

-- +migrate Up

ALTER TABLE fuel.fuel_anomalies
    ALTER COLUMN fuel_log_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS period_end   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS distance_km  NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS expected_ml  BIGINT,
    ADD COLUMN IF NOT EXISTS actual_ml    BIGINT;

DO $$ BEGIN
    ALTER TABLE fuel.fuel_anomalies
        ADD CONSTRAINT chk_fuel_anomaly_period
            CHECK ((period_start IS NULL) = (period_end IS NULL) AND (period_end IS NULL OR period_end > period_start)),
        ADD CONSTRAINT chk_fuel_anomaly_subject
            CHECK (fuel_log_id IS NOT NULL
                OR (period_start IS NOT NULL AND distance_km IS NOT NULL AND expected_ml IS NOT NULL AND actual_ml IS NOT NULL)),
        ADD CONSTRAINT chk_fuel_anomaly_amounts
            CHECK ((distance_km IS NULL OR distance_km >= 0) AND (expected_ml IS NULL OR expected_ml >= 0) AND (actual_ml IS NULL OR actual_ml >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_fuel_anomalies_period
    ON fuel.fuel_anomalies(vehicle_id, period_start, period_end)
    WHERE period_start IS NOT NULL;

-- +migrate Down

DROP INDEX IF EXISTS fuel.ux_fuel_anomalies_period;
DELETE FROM fuel.fuel_anomalies WHERE fuel_log_id IS NULL;
ALTER TABLE IF EXISTS fuel.fuel_anomalies
    DROP CONSTRAINT IF EXISTS chk_fuel_anomaly_amounts,
    DROP CONSTRAINT IF EXISTS chk_fuel_anomaly_subject,
    DROP CONSTRAINT IF EXISTS chk_fuel_anomaly_period,
    DROP COLUMN IF EXISTS actual_ml,
    DROP COLUMN IF EXISTS expected_ml,
    DROP COLUMN IF EXISTS distance_km,
    DROP COLUMN IF EXISTS period_end,
    DROP COLUMN IF EXISTS period_start,
    ALTER COLUMN fuel_log_id SET NOT NULL;
