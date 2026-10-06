-- =====================================================================
-- 004_fuel.sql
-- Architecture boundary: fuel.*
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS fuel;
REVOKE CREATE ON SCHEMA fuel FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE fuel.fuel_source AS ENUM
        ('pump', 'fuel_card', 'bulk', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE fuel.anomaly_status AS ENUM
        ('open', 'reviewed', 'dismissed', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fuel.fuel_logs (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id            BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                          ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id             BIGINT REFERENCES fleet.drivers(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    trip_id               BIGINT REFERENCES trip.trips(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    fuel_type             shared.fuel_type NOT NULL,
    quantity_ml           BIGINT NOT NULL CHECK (quantity_ml > 0),
    unit_price_cents      INTEGER CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
    total_cost_cents      INTEGER NOT NULL CHECK (total_cost_cents >= 0),
    odometer_km           NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    latitude              NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
    longitude             NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
    station_name          VARCHAR(255),
    external_reference    VARCHAR(255),
    source                fuel.fuel_source NOT NULL DEFAULT 'manual',
    recorded_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fuel.fuel_anomalies (
    id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fuel_log_id                BIGINT NOT NULL REFERENCES fuel.fuel_logs(id)
                               ON DELETE CASCADE ON UPDATE CASCADE,
    vehicle_id                 BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                               ON DELETE RESTRICT ON UPDATE CASCADE,
    anomaly_type               VARCHAR(50) NOT NULL,
    expected_consumption_ml_100km NUMERIC(12,3),
    actual_consumption_ml_100km   NUMERIC(12,3),
    deviation_percentage       NUMERIC(7,2),
    severity                   VARCHAR(20) NOT NULL DEFAULT 'medium',
    status                     fuel.anomaly_status NOT NULL DEFAULT 'open',
    detected_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by                BIGINT REFERENCES auth.users(id)
                               ON DELETE SET NULL ON UPDATE CASCADE,
    reviewed_at                TIMESTAMPTZ,
    notes                      TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_fuel_anomaly_severity
        CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE OR REPLACE TRIGGER trg_fuel_logs_updated_at
    BEFORE UPDATE ON fuel.fuel_logs
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_fuel_anomalies_updated_at
    BEFORE UPDATE ON fuel.fuel_anomalies
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TABLE IF EXISTS fuel.fuel_anomalies;
DROP TABLE IF EXISTS fuel.fuel_logs;
DROP TYPE IF EXISTS fuel.anomaly_status;
DROP TYPE IF EXISTS fuel.fuel_source;
DROP SCHEMA IF EXISTS fuel;
