-- =====================================================================
-- 058_fuel_anomaly_rules.sql
-- Per-fill-up fuel anomaly rules (FMS-82): a fill-up that is impossible or
-- suspicious on its own is flagged the moment it is logged, not at the end
-- of the month (FMS-41).
--
-- * vehicles.tank_capacity_ml: the tank's size in whole millilitres, the
--   limit a single fill-up cannot pass. Null while nobody has said: the
--   rule that needs it then judges nothing.
-- * fuel_anomalies.details: the figures a rule judged a fill-up on (the
--   tank and the fill, the distance and the fuel it needed, the price and
--   its band, the distance from where the vehicle was), so a reviewer sees
--   why without recomputing it.
-- * One anomaly per fill-up and rule: the consumer of FuelLogged runs at
--   least once, and a redelivery adds nothing.
-- =====================================================================

-- +migrate Up

ALTER TABLE fleet.vehicles
    ADD COLUMN IF NOT EXISTS tank_capacity_ml INTEGER;

DO $$ BEGIN
    ALTER TABLE fleet.vehicles
        ADD CONSTRAINT chk_vehicle_tank_capacity
            CHECK (tank_capacity_ml IS NULL OR (tank_capacity_ml > 0 AND tank_capacity_ml <= 2000000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE fuel.fuel_anomalies
    ADD COLUMN IF NOT EXISTS details JSONB;

DO $$ BEGIN
    ALTER TABLE fuel.fuel_anomalies
        ADD CONSTRAINT chk_fuel_anomaly_details
            CHECK (details IS NULL OR jsonb_typeof(details) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_fuel_anomalies_fill_up_rule
    ON fuel.fuel_anomalies(fuel_log_id, anomaly_type)
    WHERE fuel_log_id IS NOT NULL;

-- +migrate Down

DROP INDEX IF EXISTS fuel.ux_fuel_anomalies_fill_up_rule;
ALTER TABLE IF EXISTS fuel.fuel_anomalies
    DROP CONSTRAINT IF EXISTS chk_fuel_anomaly_details,
    DROP COLUMN IF EXISTS details;
ALTER TABLE IF EXISTS fleet.vehicles
    DROP CONSTRAINT IF EXISTS chk_vehicle_tank_capacity,
    DROP COLUMN IF EXISTS tank_capacity_ml;
