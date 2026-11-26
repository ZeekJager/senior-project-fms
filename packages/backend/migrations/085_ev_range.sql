-- =====================================================================
-- 085_ev_range.sql
-- EV range estimation and EV alerts (FMS-98, docs/ev.md#range).
--
-- * ev.battery_specs: a vehicle's usable battery capacity when new (kWh),
--   one row per electric vehicle, set through PUT
--   /vehicles/{vehicle_id}/battery-spec. Range = state of charge x usable
--   capacity x battery health / consumption. Without a row the capacity is
--   estimated from the vehicle's completed charging sessions.
-- * Two system settings (category EV): ev_low_soc_pct (20), below which a
--   battery reading raises BatteryThresholdExceeded, and
--   ev_battery_health_min_pct (80), the degradation line.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS ev.battery_specs (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id           BIGINT NOT NULL UNIQUE REFERENCES fleet.vehicles(id)
                         ON DELETE RESTRICT ON UPDATE CASCADE,
    usable_capacity_kwh  NUMERIC(8,2) NOT NULL CHECK (usable_capacity_kwh > 0 AND usable_capacity_kwh <= 2000),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE TRIGGER trg_ev_battery_specs_updated_at
    BEFORE UPDATE ON ev.battery_specs
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- The runtime role, as every ev table (migration 013 granted the ones that existed then).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT SELECT, INSERT, UPDATE ON ev.battery_specs TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ev TO fms_app;
    END IF;
END $$;

INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('ev_low_soc_pct', 'Low charge', 'EV',
     'A battery reading below this state of charge raises a battery alert for the vehicle.',
     'integer', '20', '{"min": 5, "max": 60, "unit": "%"}', TRUE, 'settings'),
    ('ev_battery_health_min_pct', 'Battery health', 'EV',
     'A battery whose state of health falls below this raises a degradation alert.',
     'integer', '80', '{"min": 50, "max": 99, "unit": "%"}', TRUE, 'settings')
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM settings.settings WHERE key IN ('ev_low_soc_pct', 'ev_battery_health_min_pct');
DELETE FROM settings.definitions WHERE key IN ('ev_low_soc_pct', 'ev_battery_health_min_pct');
DROP TABLE IF EXISTS ev.battery_specs;
