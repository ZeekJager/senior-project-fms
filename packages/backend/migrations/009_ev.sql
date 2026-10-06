-- =====================================================================
-- 009_ev.sql
-- Architecture boundary: ev.*
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS ev;
REVOKE CREATE ON SCHEMA ev FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE ev.charging_status AS ENUM
        ('planned', 'in_progress', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ev.charging_stations (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id          BIGINT REFERENCES integration.external_providers(id)
                         ON DELETE SET NULL ON UPDATE CASCADE,
    external_station_id  VARCHAR(255) NOT NULL,
    name                 VARCHAR(255) NOT NULL,
    latitude             NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude            NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    connector_type       VARCHAR(50),
    power_kw             NUMERIC(10,2) CHECK (power_kw IS NULL OR power_kw >= 0),
    status               VARCHAR(20) NOT NULL DEFAULT 'available',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, external_station_id)
);

CREATE TABLE IF NOT EXISTS ev.ev_battery_logs (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    state_of_charge    NUMERIC(5,2) NOT NULL CHECK (state_of_charge BETWEEN 0 AND 100),
    battery_health     NUMERIC(5,2) CHECK (battery_health IS NULL OR battery_health BETWEEN 0 AND 100),
    battery_temperature_c NUMERIC(8,2),
    voltage_v          NUMERIC(10,3),
    current_a          NUMERIC(10,3),
    estimated_range_km NUMERIC(10,2) CHECK (estimated_range_km IS NULL OR estimated_range_km >= 0),
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ev.charging_sessions (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id            BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                          ON DELETE RESTRICT ON UPDATE CASCADE,
    station_id            BIGINT REFERENCES ev.charging_stations(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    external_session_id   VARCHAR(255),
    started_at             TIMESTAMPTZ,
    ended_at               TIMESTAMPTZ,
    energy_kwh             NUMERIC(12,3) CHECK (energy_kwh IS NULL OR energy_kwh >= 0),
    cost_cents             INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
    start_soc              NUMERIC(5,2) CHECK (start_soc IS NULL OR start_soc BETWEEN 0 AND 100),
    end_soc                NUMERIC(5,2) CHECK (end_soc IS NULL OR end_soc BETWEEN 0 AND 100),
    status                 ev.charging_status NOT NULL DEFAULT 'planned',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_charging_times
        CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    CONSTRAINT uq_charging_external_session UNIQUE (external_session_id)
);

CREATE OR REPLACE TRIGGER trg_ev_stations_updated_at
    BEFORE UPDATE ON ev.charging_stations
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_ev_sessions_updated_at
    BEFORE UPDATE ON ev.charging_sessions
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TABLE IF EXISTS ev.charging_sessions;
DROP TABLE IF EXISTS ev.ev_battery_logs;
DROP TABLE IF EXISTS ev.charging_stations;
DROP TYPE IF EXISTS ev.charging_status;
DROP SCHEMA IF EXISTS ev;
