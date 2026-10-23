-- =====================================================================
-- 036_failure_events.sql
-- Failure records on corrective repairs (FMS-125).
--
-- * failure_events: what failed on a vehicle, how, and whether it was
--   unplanned, from the repair (or incident) it came from. The real
--   failure history the predictive model (FMS-52/53) trains and is
--   judged on. Kept for good: a failure is a fact, never edited.
-- * Fixed catalogues as enums (docs/maintenance.md): a new component or
--   mode is a migration, so the labels stay comparable over time.
-- * Indexes for a vehicle's failures and a component's, newest first.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE maintenance.failure_component AS ENUM
        ('engine', 'cooling', 'brakes', 'tyres', 'transmission', 'electrical', 'suspension',
         'steering', 'fuel_system', 'exhaust', 'body', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.failure_mode AS ENUM
        ('wear', 'leak', 'overheating', 'electrical_fault', 'breakage', 'puncture', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.failure_detection AS ENUM
        ('driver_report', 'dvir', 'technician', 'telematics', 'breakdown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.failure_events (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id             BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                           ON DELETE RESTRICT ON UPDATE CASCADE,
    -- The repair that found it, or the incident that reported it.
    maintenance_record_id  BIGINT REFERENCES maintenance.maintenance_records(id)
                           ON DELETE RESTRICT ON UPDATE CASCADE,
    incident_report_id     BIGINT REFERENCES alert.incident_reports(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    component              maintenance.failure_component NOT NULL,
    failure_mode           maintenance.failure_mode NOT NULL,
    -- A breakdown or a fault found in service; FALSE: found at planned work.
    unplanned              BOOLEAN NOT NULL,
    detected_by            maintenance.failure_detection NOT NULL,
    occurred_at            TIMESTAMPTZ NOT NULL,
    odometer_km            NUMERIC(12,1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
    notes                  TEXT,
    recorded_by            BIGINT REFERENCES auth.users(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_failure_source
        CHECK (maintenance_record_id IS NOT NULL OR incident_report_id IS NOT NULL)
);

-- A vehicle's failures, newest first (GET /failure-events?vehicle_id=, the training set per vehicle).
CREATE INDEX IF NOT EXISTS idx_failure_events_vehicle_time
    ON maintenance.failure_events(vehicle_id, occurred_at DESC);

-- A component's failures across the fleet (what breaks, how often).
CREATE INDEX IF NOT EXISTS idx_failure_events_component_time
    ON maintenance.failure_events(component, occurred_at DESC);

-- A repair's failures (the completion check, the record view).
CREATE INDEX IF NOT EXISTS idx_failure_events_record
    ON maintenance.failure_events(maintenance_record_id)
    WHERE maintenance_record_id IS NOT NULL;

-- +migrate Down

DROP TABLE IF EXISTS maintenance.failure_events;
DROP TYPE IF EXISTS maintenance.failure_detection;
DROP TYPE IF EXISTS maintenance.failure_mode;
DROP TYPE IF EXISTS maintenance.failure_component;
