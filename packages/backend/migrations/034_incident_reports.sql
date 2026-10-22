-- =====================================================================
-- 034_incident_reports.sql
-- Incident reports (FMS-38): what POST and GET /incidents need from the
-- incident_reports table of 008.
--
-- - depot_id: whose incident it is (depot scope for GET /incidents and the
--   socket rooms): the vehicle's depot, or the reporter's when no vehicle
--   is named. Filled in for existing rows from their vehicle.
-- - A location is both coordinates or neither.
-- - Indexes for a depot's incidents and a reporter's own, newest first.
-- =====================================================================

-- +migrate Up

ALTER TABLE alert.incident_reports ADD COLUMN IF NOT EXISTS depot_id BIGINT REFERENCES fleet.depots(id) ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE alert.incident_reports i
   SET depot_id = v.depot_id
  FROM fleet.vehicles v
 WHERE i.depot_id IS NULL AND v.id = i.vehicle_id;

DO $$ BEGIN
    ALTER TABLE alert.incident_reports ADD CONSTRAINT chk_incident_location
        CHECK ((latitude IS NULL) = (longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A depot's incidents, newest first (GET /incidents for staff).
CREATE INDEX IF NOT EXISTS idx_incidents_depot_time
    ON alert.incident_reports(depot_id, occurred_at DESC);

-- A reporter's own incidents, newest first (GET /incidents for a driver),
-- and the replay check of a late offline submission.
CREATE INDEX IF NOT EXISTS idx_incidents_reporter_time
    ON alert.incident_reports(reported_by, occurred_at DESC);

-- +migrate Down

DROP INDEX IF EXISTS alert.idx_incidents_reporter_time;
DROP INDEX IF EXISTS alert.idx_incidents_depot_time;
ALTER TABLE IF EXISTS alert.incident_reports DROP CONSTRAINT IF EXISTS chk_incident_location;
ALTER TABLE IF EXISTS alert.incident_reports DROP COLUMN IF EXISTS depot_id;
