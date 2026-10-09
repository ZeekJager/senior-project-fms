-- =====================================================================
-- 016_fleet_row_versions.sql
-- Optimistic concurrency for vehicles and drivers (FMS-16).
--
-- A version counter, bumped on every UPDATE by the same trigger function as
-- trip.trips (shared.bump_version). The API returns it as `version` and as
-- the ETag; a PATCH sent with `If-Match` for an older version is refused
-- with 409 CONFLICT_CONCURRENT_MODIFICATION instead of silently overwriting
-- someone else's change. updated_at cannot serve: it is the transaction's
-- start time, so two changes in one transaction would look the same.
-- =====================================================================

-- +migrate Up

ALTER TABLE fleet.vehicles ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet.drivers  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_fleet_vehicles_version
    BEFORE UPDATE ON fleet.vehicles
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE OR REPLACE TRIGGER trg_fleet_drivers_version
    BEFORE UPDATE ON fleet.drivers
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

-- +migrate Down

DROP TRIGGER IF EXISTS trg_fleet_drivers_version ON fleet.drivers;
DROP TRIGGER IF EXISTS trg_fleet_vehicles_version ON fleet.vehicles;
ALTER TABLE fleet.drivers  DROP COLUMN IF EXISTS version;
ALTER TABLE fleet.vehicles DROP COLUMN IF EXISTS version;
