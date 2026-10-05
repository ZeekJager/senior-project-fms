-- =====================================================================
-- 006_integration.sql
-- Architecture boundary: integration.*
-- External provider adapters are represented as configuration and
-- synchronization records. Business modules do not depend directly on
-- third-party provider table structures.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS integration;
REVOKE CREATE ON SCHEMA integration FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE integration.provider_type AS ENUM
        ('telematics', 'notification', 'mapping', 'traffic', 'weather', 'ev_charging', 'fuel_card', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS integration.external_providers (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    provider_type   integration.provider_type NOT NULL,
    base_url        TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    configuration   JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_provider_config CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE TABLE IF NOT EXISTS integration.gps_devices (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id       BIGINT REFERENCES integration.external_providers(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    vehicle_id        BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                      ON DELETE RESTRICT ON UPDATE CASCADE,
    device_identifier VARCHAR(255) NOT NULL,
    device_model      VARCHAR(255),
    installed_at      TIMESTAMPTZ,
    removed_at        TIMESTAMPTZ,
    status            VARCHAR(20) NOT NULL DEFAULT 'active',
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (device_identifier),
    CONSTRAINT chk_gps_device_status
        CHECK (status IN ('active', 'inactive', 'faulty', 'removed')),
    CONSTRAINT chk_gps_device_dates
        CHECK (removed_at IS NULL OR installed_at IS NULL OR removed_at >= installed_at)
);

CREATE TABLE IF NOT EXISTS integration.sync_logs (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id        BIGINT REFERENCES integration.external_providers(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    integration_name   VARCHAR(100) NOT NULL,
    direction          VARCHAR(20) NOT NULL,
    status             VARCHAR(20) NOT NULL,
    external_reference VARCHAR(255),
    request_id         VARCHAR(255),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at       TIMESTAMPTZ,
    error_message      TEXT,
    metadata           JSONB NOT NULL DEFAULT '{}'::JSONB,
    CONSTRAINT chk_sync_direction CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT chk_sync_status CHECK (status IN ('started', 'succeeded', 'failed', 'partial')),
    CONSTRAINT chk_sync_metadata CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS integration.fuel_card_transactions (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id           BIGINT REFERENCES integration.external_providers(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    vehicle_id            BIGINT REFERENCES fleet.vehicles(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    driver_id             BIGINT REFERENCES fleet.drivers(id)
                          ON DELETE SET NULL ON UPDATE CASCADE,
    external_transaction_id VARCHAR(255) NOT NULL,
    transaction_time      TIMESTAMPTZ NOT NULL,
    quantity_ml           BIGINT CHECK (quantity_ml IS NULL OR quantity_ml > 0),
    total_cost_cents      INTEGER CHECK (total_cost_cents IS NULL OR total_cost_cents >= 0),
    station_name          VARCHAR(255),
    raw_payload           JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT chk_fuel_card_payload CHECK (jsonb_typeof(raw_payload) = 'object')
);

CREATE OR REPLACE TRIGGER trg_integration_providers_updated_at
    BEFORE UPDATE ON integration.external_providers
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_integration_gps_devices_updated_at
    BEFORE UPDATE ON integration.gps_devices
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TABLE IF EXISTS integration.fuel_card_transactions;
DROP TABLE IF EXISTS integration.sync_logs;
DROP TABLE IF EXISTS integration.gps_devices;
DROP TABLE IF EXISTS integration.external_providers;
DROP TYPE IF EXISTS integration.provider_type;
DROP SCHEMA IF EXISTS integration;
