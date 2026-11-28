-- =====================================================================
-- 087_work_orders.sql
-- Work orders (FMS-130, docs/work-orders.md): a repair record becomes a
-- work order, with no parallel table.
--
-- * maintenance_status gains 'requested', before 'scheduled': work asked
--   for and not yet started. One above the approval threshold
--   (work_order_approval_threshold_etb) cannot start until approved:
--   approved_by and approved_at, set together.
-- * vendors: outside garages, dealers, tyre and parts suppliers; for the
--   whole fleet (depot_id NULL) or one depot. An order names its vendor,
--   with the invoice reference and the vendor's cost.
-- * work_order_tasks: the jobs an order is split into (description,
--   component from the failure catalogue, status, estimated hours).
-- * labour_entries: hours a technician worked on an order (and task), on a
--   day, at a rate in cents per hour; cost_cents = hours x rate, rounded.
--   labour_cost_cents on the order is their sum, kept by the service.
-- * An order with labour entries or a vendor is itemised: its total is
--   parts + labour + vendor, and its labour hours the entries' sum.
-- * Settings work_order_approval_threshold_etb (20,000 ETB) and
--   labour_rate_etb_per_hour (300 ETB).
-- * Permissions: maintenance:approve (admin, fleet manager, depot admin),
--   vendor:write (the same), labour-rate:read (admin, finance clerk, fleet
--   owner: the rates and labour costs); finance clerks gain
--   maintenance:read, to see what the fleet's repairs cost.
-- =====================================================================

-- +migrate Up

ALTER TYPE maintenance.maintenance_status ADD VALUE IF NOT EXISTS 'requested' BEFORE 'scheduled';

DO $$ BEGIN
    CREATE TYPE maintenance.vendor_type AS ENUM ('workshop', 'dealer', 'tyres', 'parts');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE maintenance.work_order_task_status AS ENUM ('pending', 'in_progress', 'done', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.vendors (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id     UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    name          VARCHAR(255) NOT NULL,
    vendor_type   maintenance.vendor_type NOT NULL,
    contact_name  VARCHAR(255),
    phone         VARCHAR(50),
    email         VARCHAR(255),
    -- NULL: every depot may use it.
    depot_id      BIGINT REFERENCES fleet.depots(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    notes         VARCHAR(2000),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    version       INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_vendors_name CHECK (btrim(name) <> '')
);

-- One active vendor of a name per depot (and one fleet-wide), whatever its case.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vendors_depot_name
    ON maintenance.vendors (COALESCE(depot_id, 0), lower(name)) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_vendors_updated_at
    BEFORE UPDATE ON maintenance.vendors
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_vendors_version
    BEFORE UPDATE ON maintenance.vendors
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

ALTER TABLE maintenance.maintenance_records
    ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vendor_id BIGINT REFERENCES maintenance.vendors(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS vendor_invoice_ref VARCHAR(100),
    ADD COLUMN IF NOT EXISTS vendor_cost_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS labour_cost_cents INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_records
        -- An approver always has the time; the time stays if the approver's account is later removed.
        ADD CONSTRAINT chk_maintenance_approval CHECK (approved_by IS NULL OR approved_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_records
        ADD CONSTRAINT chk_maintenance_vendor_cost CHECK (vendor_cost_cents >= 0 AND labour_cost_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_maintenance_records_vendor
    ON maintenance.maintenance_records (vendor_id) WHERE vendor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS maintenance.work_order_tasks (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    maintenance_record_id  BIGINT NOT NULL REFERENCES maintenance.maintenance_records(id) ON DELETE CASCADE ON UPDATE CASCADE,
    description            VARCHAR(500) NOT NULL,
    component              maintenance.failure_component,
    status                 maintenance.work_order_task_status NOT NULL DEFAULT 'pending',
    estimated_hours        NUMERIC(6,2),
    position               INTEGER NOT NULL DEFAULT 0,
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_by             BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    version                INTEGER NOT NULL DEFAULT 0,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_work_order_tasks_description CHECK (btrim(description) <> ''),
    CONSTRAINT chk_work_order_tasks_hours CHECK (estimated_hours IS NULL OR estimated_hours >= 0)
);

CREATE INDEX IF NOT EXISTS idx_work_order_tasks_record
    ON maintenance.work_order_tasks (maintenance_record_id, position) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_work_order_tasks_updated_at
    BEFORE UPDATE ON maintenance.work_order_tasks
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_work_order_tasks_version
    BEFORE UPDATE ON maintenance.work_order_tasks
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE TABLE IF NOT EXISTS maintenance.labour_entries (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    maintenance_record_id  BIGINT NOT NULL REFERENCES maintenance.maintenance_records(id) ON DELETE CASCADE ON UPDATE CASCADE,
    task_id                BIGINT REFERENCES maintenance.work_order_tasks(id) ON DELETE SET NULL ON UPDATE CASCADE,
    technician_id          BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    -- The Addis Ababa day the work was done.
    work_date              DATE NOT NULL,
    hours                  NUMERIC(5,2) NOT NULL,
    rate_cents             INTEGER NOT NULL,
    cost_cents             INTEGER GENERATED ALWAYS AS (round(hours * rate_cents)::integer) STORED,
    notes                  VARCHAR(1000),
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_by             BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_labour_entries_hours CHECK (hours > 0 AND hours <= 24),
    CONSTRAINT chk_labour_entries_rate CHECK (rate_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_labour_entries_record
    ON maintenance.labour_entries (maintenance_record_id) WHERE is_active;
-- Hours per technician per week (the workload report).
CREATE INDEX IF NOT EXISTS idx_labour_entries_technician_day
    ON maintenance.labour_entries (technician_id, work_date) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_labour_entries_updated_at
    BEFORE UPDATE ON maintenance.labour_entries
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

INSERT INTO auth.permissions (code, description) VALUES
    ('maintenance:approve', 'Approve a requested work order above the approval threshold'),
    ('vendor:write', 'Add, change and retire maintenance vendors'),
    ('labour-rate:read', 'See labour rates and labour costs on work orders')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE (p.code IN ('maintenance:approve', 'vendor:write') AND r.name IN ('admin', 'fleet_manager', 'depot_admin'))
    OR (p.code = 'labour-rate:read' AND r.name IN ('admin', 'finance_clerk', 'fleet_owner'))
    OR (p.code = 'maintenance:read' AND r.name = 'finance_clerk')
ON CONFLICT DO NOTHING;

-- The approval threshold and the default labour rate (settings registry, FMS-157; declared in settings.ts).
INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('work_order_approval_threshold_etb', 'Work order approval above', 'Maintenance',
     'A requested work order costing more than this must be approved by a fleet manager or depot admin before it starts.',
     'integer', '20000', '{"min": 0, "max": 10000000, "unit": "ETB"}', TRUE, 'settings'),
    ('labour_rate_etb_per_hour', 'Labour rate', 'Maintenance',
     'The workshop''s hourly labour rate, used for labour entries booked without a rate of their own.',
     'integer', '300', '{"min": 0, "max": 100000, "unit": "ETB/hour"}', TRUE, 'settings')
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM settings.settings WHERE key IN ('work_order_approval_threshold_etb', 'labour_rate_etb_per_hour');
DELETE FROM settings.definitions WHERE key IN ('work_order_approval_threshold_etb', 'labour_rate_etb_per_hour');

DELETE FROM auth.role_permissions rp
 USING auth.permissions p, auth.roles r
 WHERE rp.permission_id = p.id AND rp.role_id = r.id AND p.code = 'maintenance:read' AND r.name = 'finance_clerk';
DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code IN ('maintenance:approve', 'vendor:write', 'labour-rate:read');
DELETE FROM auth.permissions WHERE code IN ('maintenance:approve', 'vendor:write', 'labour-rate:read');

DROP TABLE IF EXISTS maintenance.labour_entries;
DROP TABLE IF EXISTS maintenance.work_order_tasks;
DROP INDEX IF EXISTS maintenance.idx_maintenance_records_vendor;
ALTER TABLE IF EXISTS maintenance.maintenance_records
    DROP CONSTRAINT IF EXISTS chk_maintenance_vendor_cost,
    DROP CONSTRAINT IF EXISTS chk_maintenance_approval,
    DROP COLUMN IF EXISTS labour_cost_cents,
    DROP COLUMN IF EXISTS vendor_cost_cents,
    DROP COLUMN IF EXISTS vendor_invoice_ref,
    DROP COLUMN IF EXISTS vendor_id,
    DROP COLUMN IF EXISTS approved_at,
    DROP COLUMN IF EXISTS approved_by;
DROP TABLE IF EXISTS maintenance.vendors;
DROP TYPE IF EXISTS maintenance.work_order_task_status;
DROP TYPE IF EXISTS maintenance.vendor_type;

-- An enum value cannot be dropped: the type is made again without 'requested'. A requested order that was never
-- started is cancelled. The views reading the column are kept as they are now, dropped and made again around it.
DO $$
DECLARE
    v record;
    saved text[] := '{}';
    names text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                    WHERE n.nspname = 'maintenance' AND t.typname = 'maintenance_status' AND e.enumlabel = 'requested') THEN
        RETURN;
    END IF;
    UPDATE maintenance.maintenance_records SET status = 'cancelled' WHERE status::text = 'requested';
    FOR v IN
        SELECT DISTINCT c.oid::regclass::text AS name, pg_get_viewdef(c.oid, true) AS def
          FROM pg_depend d
          JOIN pg_rewrite r ON r.oid = d.objid
          JOIN pg_class c ON c.oid = r.ev_class
          JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
         WHERE d.refobjid = 'maintenance.maintenance_records'::regclass AND a.attname = 'status' AND c.oid <> d.refobjid
    LOOP
        names := names || v.name;
        saved := saved || v.def;
        EXECUTE format('DROP VIEW %s', v.name);
    END LOOP;
    ALTER TABLE maintenance.maintenance_records ALTER COLUMN status DROP DEFAULT;
    ALTER TYPE maintenance.maintenance_status RENAME TO maintenance_status_wo;
    CREATE TYPE maintenance.maintenance_status AS ENUM ('scheduled', 'open', 'in_progress', 'completed', 'cancelled');
    ALTER TABLE maintenance.maintenance_records
        ALTER COLUMN status TYPE maintenance.maintenance_status USING status::text::maintenance.maintenance_status;
    ALTER TABLE maintenance.maintenance_records ALTER COLUMN status SET DEFAULT 'open';
    DROP TYPE maintenance.maintenance_status_wo;
    FOR i IN 1 .. coalesce(array_length(names, 1), 0) LOOP
        EXECUTE format('CREATE VIEW %s AS %s', names[i], saved[i]);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
            EXECUTE format('GRANT SELECT ON %s TO fms_app', names[i]);
        END IF;
    END LOOP;
END $$;
