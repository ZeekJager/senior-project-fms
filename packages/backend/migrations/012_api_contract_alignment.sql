-- =====================================================================
-- 012_api_contract_alignment.sql
-- Aligns the schema with docs/api-contract.md (combined v1):
--   * public UUID identifiers for every resource the API exposes (§3.5)
--   * document metadata (§8) and idempotency keys (§19)
--   * trip overlap rules enforced by the database, not only the API (§17)
--   * de-duplication of retried telemetry (§15)
--   * defaults for incident fields POST /incidents does not send (§12.2)
--
-- Requires the btree_gist extension (shipped with PostgreSQL; trusted,
-- so the database owner can create it).
-- =====================================================================

-- +migrate Up

-- ---------------------------------------------------------------------
-- Public identifiers. Joins and foreign keys keep the BIGINT keys; the
-- API exposes only public_id, so identifiers are not sequential or
-- guessable. Resolve public_id -> id once at the API boundary.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'auth.users',
        'fleet.depots', 'fleet.vehicles', 'fleet.drivers',
        'fleet.driver_vehicle_assignments', 'fleet.driver_attendance',
        'fleet.dvir_reports',
        'trip.routes', 'trip.trips', 'trip.trip_stops',
        'fuel.fuel_logs', 'fuel.fuel_anomalies',
        'maintenance.maintenance_records', 'maintenance.inventory_parts',
        'maintenance.inventory_movements', 'maintenance.maintenance_predictions',
        'integration.external_providers', 'integration.sync_logs',
        'tracking.telemetry_flags',
        'alert.alerts', 'alert.notifications', 'alert.incident_reports',
        'ev.ev_battery_logs', 'ev.charging_stations', 'ev.charging_sessions']
    LOOP
        EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid()', t);
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (public_id)',
                       'ux_' || replace(t, '.', '_') || '_public_id', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- document.* — metadata for files held in object storage (§8). The file
-- itself never lives in PostgreSQL.
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS document;
REVOKE CREATE ON SCHEMA document FROM PUBLIC;

CREATE TABLE IF NOT EXISTS document.documents (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    -- What the file belongs to. Polymorphic (like alert.alerts.source_*),
    -- so it cannot be a single FK. The API must check the caller may read
    -- the owner before issuing a signed URL.
    owner_type        VARCHAR(50) NOT NULL,
    owner_id          BIGINT NOT NULL,
    document_type     VARCHAR(50) NOT NULL,
    -- Server-generated object key; never derived from the upload filename.
    storage_key       VARCHAR(512) NOT NULL UNIQUE,
    original_filename VARCHAR(255),
    content_type      VARCHAR(100) NOT NULL,
    size_bytes        INTEGER NOT NULL,
    sha256            CHAR(64) NOT NULL,
    uploaded_by       BIGINT NOT NULL REFERENCES auth.users(id),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    retain_until      DATE,
    -- Soft delete (DELETE /documents is a retirement, subject to retention).
    deleted_at        TIMESTAMPTZ,
    deleted_by        BIGINT REFERENCES auth.users(id),
    CONSTRAINT chk_document_owner_type CHECK (owner_type IN
        ('vehicle', 'driver', 'trip', 'maintenance_record', 'incident_report',
         'dvir_report', 'fuel_log')),
    CONSTRAINT chk_document_type CHECK (document_type IN
        ('registration', 'licence', 'insurance', 'maintenance_invoice',
         'inspection_evidence', 'incident_photo', 'dvir_attachment',
         'fuel_receipt', 'other')),
    CONSTRAINT chk_document_content_type CHECK (content_type IN
        ('image/jpeg', 'image/png', 'application/pdf')),
    CONSTRAINT chk_document_size CHECK (size_bytes BETWEEN 1 AND 10485760),
    CONSTRAINT chk_document_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_document_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_document_owner
    ON document.documents(owner_type, owner_id)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- api.idempotency_keys — Idempotency-Key store (§19). Usage:
--   INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING;
--   conflict + different request_hash -> 409 CONFLICT_IDEMPOTENCY_KEY_REUSED
--   conflict + status 'in_progress'   -> 409 (request still running)
--   conflict + status 'completed'     -> replay response_status/body
-- Webhooks de-duplicate on provider event keys instead (see below).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS api;
REVOKE CREATE ON SCHEMA api FROM PUBLIC;

CREATE TABLE IF NOT EXISTS api.idempotency_keys (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES auth.users(id),
    idempotency_key  VARCHAR(255) NOT NULL,
    request_method   VARCHAR(10) NOT NULL,
    request_path     VARCHAR(255) NOT NULL,
    request_hash     CHAR(64) NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    response_status  SMALLINT,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_idempotency_caller_key UNIQUE (user_id, idempotency_key),
    CONSTRAINT chk_idempotency_status CHECK (status IN ('in_progress', 'completed')),
    CONSTRAINT chk_idempotency_outcome
        CHECK ((status = 'completed') = (response_status IS NOT NULL)),
    CONSTRAINT chk_idempotency_expiry CHECK (expires_at > created_at)
);

-- Purge job: DELETE FROM api.idempotency_keys WHERE expires_at < now().
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON api.idempotency_keys(expires_at);

-- ---------------------------------------------------------------------
-- Trip overlap (§7.2, §17). The API checks first so it can answer with
-- the right 409 code, but only the database closes the race where two
-- concurrent assignments both pass that check. A violation raises
-- SQLSTATE 23P01; map ex_trip_driver_overlap -> CONFLICT_DRIVER_OVERLAP
-- and ex_trip_vehicle_overlap -> CONFLICT_VEHICLE_OVERLAP.
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
    ALTER TABLE trip.trips
        ADD CONSTRAINT ex_trip_driver_overlap
        EXCLUDE USING gist (
            driver_id WITH =,
            tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
        ) WHERE (status IN ('assigned', 'en_route'));
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE trip.trips
        ADD CONSTRAINT ex_trip_vehicle_overlap
        EXCLUDE USING gist (
            vehicle_id WITH =,
            tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
        ) WHERE (status IN ('assigned', 'en_route'));
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Telemetry retries (§15). One ping per vehicle per instant; webhook
-- handlers insert with ON CONFLICT DO NOTHING, so a provider retry is a
-- no-op. (Fuel-card and EV events already de-duplicate on their
-- provider ids.) The partition key is part of the constraint, as
-- PostgreSQL requires for partitioned tables.
-- ---------------------------------------------------------------------
DO $$ BEGIN
    ALTER TABLE tracking.gps_pings
        ADD CONSTRAINT uq_gps_ping_vehicle_time UNIQUE (vehicle_id, recorded_at);
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- POST /incidents sends vehicle_id, trip_id, description, severity only.
-- reported_by comes from the authenticated user; these cover the rest.
-- ---------------------------------------------------------------------
ALTER TABLE alert.incident_reports ALTER COLUMN occurred_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE alert.incident_reports ALTER COLUMN incident_type SET DEFAULT 'other';

-- +migrate Down

ALTER TABLE IF EXISTS alert.incident_reports ALTER COLUMN incident_type DROP DEFAULT;
ALTER TABLE IF EXISTS alert.incident_reports ALTER COLUMN occurred_at DROP DEFAULT;

ALTER TABLE IF EXISTS tracking.gps_pings DROP CONSTRAINT IF EXISTS uq_gps_ping_vehicle_time;

ALTER TABLE IF EXISTS trip.trips DROP CONSTRAINT IF EXISTS ex_trip_vehicle_overlap;
ALTER TABLE IF EXISTS trip.trips DROP CONSTRAINT IF EXISTS ex_trip_driver_overlap;
DROP EXTENSION IF EXISTS btree_gist;

DROP TABLE IF EXISTS api.idempotency_keys;
DROP SCHEMA IF EXISTS api;

DROP TABLE IF EXISTS document.documents;
DROP SCHEMA IF EXISTS document;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'auth.users',
        'fleet.depots', 'fleet.vehicles', 'fleet.drivers',
        'fleet.driver_vehicle_assignments', 'fleet.driver_attendance',
        'fleet.dvir_reports',
        'trip.routes', 'trip.trips', 'trip.trip_stops',
        'fuel.fuel_logs', 'fuel.fuel_anomalies',
        'maintenance.maintenance_records', 'maintenance.inventory_parts',
        'maintenance.inventory_movements', 'maintenance.maintenance_predictions',
        'integration.external_providers', 'integration.sync_logs',
        'tracking.telemetry_flags',
        'alert.alerts', 'alert.notifications', 'alert.incident_reports',
        'ev.ev_battery_logs', 'ev.charging_stations', 'ev.charging_sessions']
    LOOP
        -- Dropping the column also drops its unique index.
        EXECUTE format('ALTER TABLE IF EXISTS %s DROP COLUMN IF EXISTS public_id', t);
    END LOOP;
END $$;
