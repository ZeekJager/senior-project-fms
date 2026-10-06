-- =====================================================================
-- 005_maintenance.sql
-- Architecture boundary: maintenance.*
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS maintenance;
REVOKE CREATE ON SCHEMA maintenance FROM PUBLIC;

DO $$ BEGIN
    CREATE TYPE maintenance.maintenance_status AS ENUM
        ('scheduled', 'open', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.maintenance_type AS ENUM
        ('preventive', 'corrective', 'predictive', 'inspection', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.inventory_parts (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    depot_id           BIGINT REFERENCES fleet.depots(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    part_number        VARCHAR(100) NOT NULL UNIQUE,
    name               VARCHAR(255) NOT NULL,
    description        TEXT,
    unit_cost_cents    INTEGER CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
    stock_quantity     INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    reorder_threshold  INTEGER NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance.maintenance_records (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id         BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                       ON DELETE RESTRICT ON UPDATE CASCADE,
    technician_id      BIGINT REFERENCES auth.users(id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    maintenance_type   maintenance.maintenance_type NOT NULL DEFAULT 'other',
    description        TEXT,
    status             maintenance.maintenance_status NOT NULL DEFAULT 'open',
    priority           VARCHAR(20) NOT NULL DEFAULT 'normal',
    scheduled_at       TIMESTAMPTZ,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    odometer_km        NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    labor_hours        NUMERIC(8,2) CHECK (labor_hours IS NULL OR labor_hours >= 0),
    total_cost_cents   INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_cents >= 0),
    workshop           VARCHAR(255),
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_maintenance_priority
        CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    CONSTRAINT chk_maintenance_times
        CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS maintenance.maintenance_parts (
    maintenance_record_id BIGINT NOT NULL REFERENCES maintenance.maintenance_records(id)
                          ON DELETE CASCADE ON UPDATE CASCADE,
    inventory_part_id     BIGINT NOT NULL REFERENCES maintenance.inventory_parts(id)
                          ON DELETE RESTRICT ON UPDATE CASCADE,
    quantity              INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost_cents       INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (maintenance_record_id, inventory_part_id)
);

CREATE TABLE IF NOT EXISTS maintenance.inventory_movements (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_part_id   BIGINT NOT NULL REFERENCES maintenance.inventory_parts(id)
                        ON DELETE RESTRICT ON UPDATE CASCADE,
    depot_id            BIGINT REFERENCES fleet.depots(id)
                        ON DELETE SET NULL ON UPDATE CASCADE,
    movement_type       VARCHAR(30) NOT NULL,
    quantity_delta      INTEGER NOT NULL,
    reference_type      VARCHAR(50),
    reference_id        BIGINT,
    performed_by        BIGINT REFERENCES auth.users(id)
                        ON DELETE SET NULL ON UPDATE CASCADE,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes               TEXT,
    CONSTRAINT chk_inventory_movement_type
        CHECK (movement_type IN ('purchase', 'consumption', 'adjustment', 'transfer_in', 'transfer_out', 'return')),
    CONSTRAINT chk_inventory_quantity_delta CHECK (quantity_delta <> 0)
);

CREATE TABLE IF NOT EXISTS maintenance.maintenance_predictions (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id              BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                            ON DELETE RESTRICT ON UPDATE CASCADE,
    model_name              VARCHAR(100) NOT NULL,
    model_version           VARCHAR(100) NOT NULL,
    prediction_type         VARCHAR(100) NOT NULL,
    risk_score              NUMERIC(6,5) NOT NULL CHECK (risk_score BETWEEN 0 AND 1),
    predicted_failure_type  VARCHAR(255),
    prediction_horizon_days INTEGER CHECK (prediction_horizon_days IS NULL OR prediction_horizon_days >= 0),
    confidence              NUMERIC(6,5) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    feature_snapshot        JSONB,
    generated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_prediction_status
        CHECK (status IN ('active', 'superseded', 'dismissed')),
    CONSTRAINT chk_prediction_features
        CHECK (feature_snapshot IS NULL OR jsonb_typeof(feature_snapshot) = 'object')
);

CREATE OR REPLACE TRIGGER trg_maintenance_inventory_parts_updated_at
    BEFORE UPDATE ON maintenance.inventory_parts
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_maintenance_records_updated_at
    BEFORE UPDATE ON maintenance.maintenance_records
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_maintenance_predictions_updated_at
    BEFORE UPDATE ON maintenance.maintenance_predictions
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TABLE IF EXISTS maintenance.maintenance_predictions;
DROP TABLE IF EXISTS maintenance.inventory_movements;
DROP TABLE IF EXISTS maintenance.maintenance_parts;
DROP TABLE IF EXISTS maintenance.maintenance_records;
DROP TABLE IF EXISTS maintenance.inventory_parts;
DROP TYPE IF EXISTS maintenance.maintenance_type;
DROP TYPE IF EXISTS maintenance.maintenance_status;
DROP SCHEMA IF EXISTS maintenance;
