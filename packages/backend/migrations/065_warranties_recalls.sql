-- =====================================================================
-- 065_warranties_recalls.sql
-- Warranty and recall tracking (FMS-133, docs/warranties-recalls.md).
--
-- * warranties: a vehicle's warranty, on the whole vehicle (component
--   NULL) or one component of the failure catalogue (FMS-125), from a
--   provider, from a start date to an end date, an end odometer, or both
--   (whichever comes first). Voided, never deleted.
-- * maintenance_records gains the warranty claim: a repair that found a
--   failure the vehicle's warranty covered on its work date (and within
--   its end odometer) is claimable (warranty_id, claim_status
--   'claimable'); the claim then goes submitted, approved (with the
--   amount recovered) or rejected.
-- * recalls: a manufacturer's campaign for a make, model and model years.
--   recall_vehicles: each vehicle it matches, open, scheduled (a work
--   order booked, maintenance_record_id) or completed.
-- * expiry_notices (FMS-26) takes 'warranty': the expiry job warns of a
--   warranty's end date as it does a document's, once per level.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS maintenance.warranties (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id      BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                    ON DELETE RESTRICT ON UPDATE CASCADE,
    -- NULL: the whole vehicle.
    component       maintenance.failure_component,
    provider        VARCHAR(255) NOT NULL,
    coverage        TEXT,
    starts_on       DATE NOT NULL,
    ends_on         DATE,
    -- The odometer reading at which cover ends.
    ends_km         NUMERIC(12,1),
    terms           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    version         INTEGER NOT NULL DEFAULT 0,
    created_by      BIGINT REFERENCES auth.users(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_warranty_provider CHECK (length(btrim(provider)) > 0),
    CONSTRAINT chk_warranty_end CHECK (ends_on IS NOT NULL OR ends_km IS NOT NULL),
    CONSTRAINT chk_warranty_dates CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT chk_warranty_km CHECK (ends_km IS NULL OR ends_km > 0)
);

-- A vehicle's warranties; the expiry job's live ones by end date.
CREATE INDEX IF NOT EXISTS idx_warranties_vehicle ON maintenance.warranties (vehicle_id, starts_on);
CREATE INDEX IF NOT EXISTS idx_warranties_ends_on ON maintenance.warranties (ends_on) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_warranties_updated_at
    BEFORE UPDATE ON maintenance.warranties
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_warranties_version
    BEFORE UPDATE ON maintenance.warranties
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

ALTER TABLE maintenance.maintenance_records
    ADD COLUMN IF NOT EXISTS warranty_id BIGINT REFERENCES maintenance.warranties(id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS claim_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS claim_amount_cents INTEGER,
    ADD COLUMN IF NOT EXISTS claim_reference VARCHAR(100),
    ADD COLUMN IF NOT EXISTS claim_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claim_updated_by BIGINT REFERENCES auth.users(id)
        ON DELETE SET NULL ON UPDATE CASCADE;

DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_records ADD CONSTRAINT chk_maintenance_claim
        CHECK ((warranty_id IS NULL) = (claim_status IS NULL)
           AND (claim_status IS NULL OR claim_status IN ('claimable', 'submitted', 'approved', 'rejected'))
           AND (claim_amount_cents IS NULL OR claim_amount_cents >= 0)
           -- The amount recovered: on an approved claim, and only there.
           AND (claim_amount_cents IS NOT NULL) = (claim_status IS NOT DISTINCT FROM 'approved'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The claims under a warranty.
CREATE INDEX IF NOT EXISTS idx_maintenance_records_warranty
    ON maintenance.maintenance_records (warranty_id)
    WHERE warranty_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS maintenance.recalls (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    campaign_code   VARCHAR(50) NOT NULL,
    make            VARCHAR(100) NOT NULL,
    model           VARCHAR(100) NOT NULL,
    year_from       SMALLINT NOT NULL,
    year_to         SMALLINT NOT NULL,
    description     TEXT NOT NULL,
    remedy          TEXT,
    issued_on       DATE,
    version         INTEGER NOT NULL DEFAULT 0,
    created_by      BIGINT REFERENCES auth.users(id)
                    ON DELETE SET NULL ON UPDATE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_recall_code CHECK (length(btrim(campaign_code)) > 0),
    CONSTRAINT chk_recall_years CHECK (year_from BETWEEN 1900 AND 2100 AND year_to BETWEEN year_from AND 2100),
    CONSTRAINT chk_recall_description CHECK (length(btrim(description)) > 0)
);

-- A campaign once, whatever its case.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recalls_campaign_code ON maintenance.recalls (upper(campaign_code));

CREATE OR REPLACE TRIGGER trg_recalls_updated_at
    BEFORE UPDATE ON maintenance.recalls
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_recalls_version
    BEFORE UPDATE ON maintenance.recalls
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

DO $$ BEGIN
    CREATE TYPE maintenance.recall_vehicle_status AS ENUM ('open', 'scheduled', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.recall_vehicles (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recall_id              BIGINT NOT NULL REFERENCES maintenance.recalls(id)
                           ON DELETE CASCADE ON UPDATE CASCADE,
    vehicle_id             BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                           ON DELETE RESTRICT ON UPDATE CASCADE,
    status                 maintenance.recall_vehicle_status NOT NULL DEFAULT 'open',
    -- The work order that carries out the remedy.
    maintenance_record_id  BIGINT REFERENCES maintenance.maintenance_records(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    completed_at           TIMESTAMPTZ,
    notes                  TEXT,
    matched_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by             BIGINT REFERENCES auth.users(id)
                           ON DELETE SET NULL ON UPDATE CASCADE,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_recall_vehicle UNIQUE (recall_id, vehicle_id),
    CONSTRAINT chk_recall_vehicle_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- A vehicle's recalls, and its open ones.
CREATE INDEX IF NOT EXISTS idx_recall_vehicles_vehicle ON maintenance.recall_vehicles (vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_recall_vehicles_record
    ON maintenance.recall_vehicles (maintenance_record_id)
    WHERE maintenance_record_id IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_recall_vehicles_updated_at
    BEFORE UPDATE ON maintenance.recall_vehicles
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

ALTER TABLE fleet.expiry_notices DROP CONSTRAINT IF EXISTS chk_expiry_notice_subject;
ALTER TABLE fleet.expiry_notices ADD CONSTRAINT chk_expiry_notice_subject
    CHECK (subject_type IN ('document', 'licence', 'warranty'));

-- +migrate Down

DELETE FROM fleet.expiry_notices WHERE subject_type = 'warranty';
ALTER TABLE fleet.expiry_notices DROP CONSTRAINT IF EXISTS chk_expiry_notice_subject;
ALTER TABLE fleet.expiry_notices ADD CONSTRAINT chk_expiry_notice_subject
    CHECK (subject_type IN ('document', 'licence'));

DROP TABLE IF EXISTS maintenance.recall_vehicles;
DROP TYPE IF EXISTS maintenance.recall_vehicle_status;
DROP TABLE IF EXISTS maintenance.recalls;
DROP INDEX IF EXISTS maintenance.idx_maintenance_records_warranty;
ALTER TABLE IF EXISTS maintenance.maintenance_records DROP CONSTRAINT IF EXISTS chk_maintenance_claim;
ALTER TABLE IF EXISTS maintenance.maintenance_records
    DROP COLUMN IF EXISTS claim_updated_by,
    DROP COLUMN IF EXISTS claim_updated_at,
    DROP COLUMN IF EXISTS claim_reference,
    DROP COLUMN IF EXISTS claim_amount_cents,
    DROP COLUMN IF EXISTS claim_status,
    DROP COLUMN IF EXISTS warranty_id;
DROP TABLE IF EXISTS maintenance.warranties;
