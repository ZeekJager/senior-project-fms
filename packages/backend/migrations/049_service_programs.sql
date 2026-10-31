-- =====================================================================
-- 049_service_programs.sql
-- Preventive service programs and service due (FMS-129).
--
-- * service_programs: a schedule of preventive service, fleet-wide
--   (depot_id NULL) or for one depot, for the vehicles it matches (vehicle
--   type, fuel type, make and model; NULL matches any), due by distance,
--   time or engine hours, whichever comes first. Each interval has its
--   lead window (the same measure, smaller than the interval): within it
--   the service is due, past the interval it is overdue. The checklist is
--   a JSON array of task names. Programs are retired, never deleted.
-- * maintenance_records.service_program_id: the program a preventive
--   repair carries out. Completing it starts the program's count again.
-- * service_due: one row per vehicle and program that applies to it, as
--   the service-due job (and each completion or program change) last
--   computed it: what it counts from, when each measure falls due, the
--   readings it was judged on, and the status (upcoming, due, overdue).
--   A read model of programs, repairs and meter readings: rebuilt by the
--   job, so a row of a vehicle or program goes with it.
-- * service-program:write (admin, fleet manager, depot admin): who
--   defines programs. Technicians hold maintenance:write to log repairs,
--   not to set the fleet's service policy.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS maintenance.service_programs (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    name                   VARCHAR(120) NOT NULL,
    description            TEXT,
    depot_id               BIGINT REFERENCES fleet.depots(id)
                           ON DELETE RESTRICT ON UPDATE CASCADE,
    vehicle_type           shared.vehicle_type,
    fuel_type              shared.fuel_type,
    make                   VARCHAR(100),
    model                  VARCHAR(100),
    interval_km            INTEGER,
    lead_km                INTEGER,
    interval_days          INTEGER,
    lead_days              INTEGER,
    interval_engine_hours  INTEGER,
    lead_engine_hours      INTEGER,
    tasks                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    version                INTEGER NOT NULL DEFAULT 0,
    created_by             BIGINT REFERENCES auth.users(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_service_program_name CHECK (length(btrim(name)) > 0),
    CONSTRAINT chk_service_program_interval
        CHECK (interval_km IS NOT NULL OR interval_days IS NOT NULL OR interval_engine_hours IS NOT NULL),
    -- Each interval comes with its lead window, smaller than it.
    CONSTRAINT chk_service_program_km
        CHECK ((interval_km IS NULL AND lead_km IS NULL)
            OR (interval_km > 0 AND lead_km >= 0 AND lead_km < interval_km)),
    CONSTRAINT chk_service_program_days
        CHECK ((interval_days IS NULL AND lead_days IS NULL)
            OR (interval_days > 0 AND lead_days >= 0 AND lead_days < interval_days)),
    CONSTRAINT chk_service_program_hours
        CHECK ((interval_engine_hours IS NULL AND lead_engine_hours IS NULL)
            OR (interval_engine_hours > 0 AND lead_engine_hours >= 0 AND lead_engine_hours < interval_engine_hours)),
    CONSTRAINT chk_service_program_model CHECK (model IS NULL OR make IS NOT NULL),
    CONSTRAINT chk_service_program_tasks CHECK (jsonb_typeof(tasks) = 'array')
);

-- One active program of a name per depot, and one fleet-wide.
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_programs_name
    ON maintenance.service_programs (COALESCE(depot_id, 0), lower(name))
    WHERE is_active;

CREATE OR REPLACE TRIGGER trg_service_programs_updated_at
    BEFORE UPDATE ON maintenance.service_programs
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_service_programs_version
    BEFORE UPDATE ON maintenance.service_programs
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

ALTER TABLE maintenance.maintenance_records
    ADD COLUMN IF NOT EXISTS service_program_id BIGINT REFERENCES maintenance.service_programs(id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_records ADD CONSTRAINT chk_maintenance_service_program
        CHECK (service_program_id IS NULL OR maintenance_type = 'preventive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The last completed service of a program on a vehicle.
CREATE INDEX IF NOT EXISTS idx_maintenance_records_program
    ON maintenance.maintenance_records (vehicle_id, service_program_id, completed_at DESC)
    WHERE service_program_id IS NOT NULL;

DO $$ BEGIN
    CREATE TYPE maintenance.service_due_status AS ENUM ('upcoming', 'due', 'overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.service_due (
    vehicle_id              BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                            ON DELETE CASCADE ON UPDATE CASCADE,
    program_id              BIGINT NOT NULL REFERENCES maintenance.service_programs(id)
                            ON DELETE CASCADE ON UPDATE CASCADE,
    -- The completed repair it counts from; NULL: none on record, counted from the vehicle's first reading.
    last_record_id          BIGINT REFERENCES maintenance.maintenance_records(id)
                            ON DELETE SET NULL ON UPDATE CASCADE,
    since_at                TIMESTAMPTZ NOT NULL,
    since_km                NUMERIC(12,1) NOT NULL,
    since_engine_hours      NUMERIC(10,1),
    next_due_km             NUMERIC(12,1),
    next_due_at             TIMESTAMPTZ,
    next_due_engine_hours   NUMERIC(10,1),
    -- The readings it was judged on.
    odometer_km             NUMERIC(12,1) NOT NULL,
    engine_hours            NUMERIC(10,1),
    status                  maintenance.service_due_status NOT NULL,
    -- The measures that made it due or overdue: km, days, engine_hours.
    due_by                  TEXT[] NOT NULL DEFAULT '{}',
    status_changed_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    computed_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vehicle_id, program_id)
);

CREATE INDEX IF NOT EXISTS idx_service_due_attention
    ON maintenance.service_due (status, vehicle_id)
    WHERE status <> 'upcoming';

CREATE INDEX IF NOT EXISTS idx_service_due_program ON maintenance.service_due (program_id);

INSERT INTO auth.permissions (code, description) VALUES
    ('service-program:write', 'Define preventive service programs')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name IN ('admin', 'fleet_manager', 'depot_admin') AND p.code = 'service-program:write'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'service-program:write';
DELETE FROM auth.permissions WHERE code = 'service-program:write';

DROP TABLE IF EXISTS maintenance.service_due;
DROP TYPE IF EXISTS maintenance.service_due_status;
DROP INDEX IF EXISTS maintenance.idx_maintenance_records_program;
ALTER TABLE IF EXISTS maintenance.maintenance_records DROP CONSTRAINT IF EXISTS chk_maintenance_service_program;
ALTER TABLE IF EXISTS maintenance.maintenance_records DROP COLUMN IF EXISTS service_program_id;
DROP TRIGGER IF EXISTS trg_service_programs_version ON maintenance.service_programs;
DROP TRIGGER IF EXISTS trg_service_programs_updated_at ON maintenance.service_programs;
DROP INDEX IF EXISTS maintenance.ux_service_programs_name;
DROP TABLE IF EXISTS maintenance.service_programs;
