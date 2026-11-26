-- =====================================================================
-- 084_ev_synthetic_data.sql
-- EV synthetic data and the simulated charging provider (FMS-97, docs/ev.md#synthetic-data).
--
-- There is no real EV data source (decision D-06): the EV module is built,
-- tested and shown on fabricated data, and every fabricated row says so.
--
-- * source on ev.ev_battery_logs, ev.charging_sessions and
--   ev.charging_stations: 'manual' (typed through the API, the default and
--   every row so far), 'provider' (a charging provider's webhook) or
--   'synthetic' (the generator, `npm run seed -- --with-ev`, and the
--   simulated charging provider).
-- * ev.ev_battery_logs.energy_wh_per_km: the energy the vehicle used per
--   km since its previous reading, as its battery management system
--   reports it.
-- * The ev_charging provider 'simulated' (POST /webhooks/ev/simulated),
--   added switched off, like the GPS simulator's (migration 061): the EV
--   simulator switches it on, and a production database never has it on.
-- =====================================================================

-- +migrate Up

ALTER TABLE ev.ev_battery_logs
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS energy_wh_per_km NUMERIC(8,2);
ALTER TABLE ev.charging_sessions ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE ev.charging_stations ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';

DO $$ BEGIN
    ALTER TABLE ev.ev_battery_logs ADD CONSTRAINT chk_ev_battery_logs_source CHECK (source IN ('manual', 'provider', 'synthetic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ev.ev_battery_logs ADD CONSTRAINT chk_ev_battery_logs_energy
        CHECK (energy_wh_per_km IS NULL OR energy_wh_per_km BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ev.charging_sessions ADD CONSTRAINT chk_charging_sessions_source CHECK (source IN ('manual', 'provider', 'synthetic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE ev.charging_stations ADD CONSTRAINT chk_charging_stations_source CHECK (source IN ('manual', 'provider', 'synthetic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO integration.external_providers (code, name, provider_type, is_active, configuration)
VALUES ('simulated', 'Simulated charging network', 'ev_charging', FALSE, '{}'::JSONB)
ON CONFLICT (code) DO NOTHING;

-- +migrate Down

DELETE FROM integration.external_providers p
 WHERE p.code = 'simulated'
   AND NOT EXISTS (SELECT 1 FROM ev.charging_stations s WHERE s.provider_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM integration.sync_logs l WHERE l.provider_id = p.id);
ALTER TABLE IF EXISTS ev.charging_stations DROP COLUMN IF EXISTS source;
ALTER TABLE IF EXISTS ev.charging_sessions DROP COLUMN IF EXISTS source;
ALTER TABLE IF EXISTS ev.ev_battery_logs DROP COLUMN IF EXISTS energy_wh_per_km;
ALTER TABLE IF EXISTS ev.ev_battery_logs DROP COLUMN IF EXISTS source;
