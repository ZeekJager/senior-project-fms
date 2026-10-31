-- =====================================================================
-- 047_incident_handling.sql
-- Handling an incident from the command center (FMS-89): who is dealing
-- with it, what they found and did, and when it was resolved.
--
-- * incident_reports: assigned_to (the staff member dealing with it),
--   notes (what was found and done; required to resolve or close), and
--   resolved_at / resolved_by, set when it is resolved or closed and
--   cleared when it is reopened (chk_incident_resolved). The status
--   values are 008's: open, investigating, resolved, closed.
-- * The command center lists the active incidents of a depot, newest
--   first: idx_incidents_active.
-- * incident:manage: changing an incident's status, assignee and notes.
--   Reporting stays incident:write, which drivers hold; a driver reports
--   an incident but does not close it. Granted to admins, fleet managers,
--   dispatchers and depot admins.
-- =====================================================================

-- +migrate Up

ALTER TABLE alert.incident_reports
    ADD COLUMN IF NOT EXISTS assigned_to BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS notes       TEXT,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- An incident resolved or closed before this migration has no resolution time: its last change stands in.
UPDATE alert.incident_reports SET resolved_at = updated_at WHERE status IN ('resolved', 'closed') AND resolved_at IS NULL;

DO $$ BEGIN
    ALTER TABLE alert.incident_reports
        ADD CONSTRAINT chk_incident_notes CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 4000),
        ADD CONSTRAINT chk_incident_resolved CHECK ((status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_incidents_active
    ON alert.incident_reports(depot_id, occurred_at DESC)
    WHERE status IN ('open', 'investigating');

INSERT INTO auth.permissions (code, description) VALUES
    ('incident:manage', 'Handle incidents: status, assignee and notes')
ON CONFLICT (code) DO NOTHING;

UPDATE auth.permissions SET description = 'Report incidents' WHERE code = 'incident:write';

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name IN ('admin', 'fleet_manager', 'dispatcher', 'depot_admin') AND p.code = 'incident:manage'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'incident:manage';
DELETE FROM auth.permissions WHERE code = 'incident:manage';
UPDATE auth.permissions SET description = 'Report and update incidents' WHERE code = 'incident:write';

DROP INDEX IF EXISTS alert.idx_incidents_active;
ALTER TABLE IF EXISTS alert.incident_reports DROP CONSTRAINT IF EXISTS chk_incident_resolved;
ALTER TABLE IF EXISTS alert.incident_reports DROP CONSTRAINT IF EXISTS chk_incident_notes;
ALTER TABLE IF EXISTS alert.incident_reports
    DROP COLUMN IF EXISTS resolved_by,
    DROP COLUMN IF EXISTS resolved_at,
    DROP COLUMN IF EXISTS notes,
    DROP COLUMN IF EXISTS assigned_to;
