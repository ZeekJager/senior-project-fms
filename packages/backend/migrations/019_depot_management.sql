-- =====================================================================
-- 019_depot_management.sql
-- Depot CRUD (FMS-20).
--
-- * fleet.depots gets the version counter vehicles and drivers have (016),
--   so PATCH/PUT /depots can refuse a stale write (If-Match).
-- * Codes are stored trimmed and upper case, as the API writes them.
-- * Only admin and fleet_owner manage depots (the card): depot:write moves
--   from fleet_manager to fleet_owner. A fleet manager keeps depot:read.
-- =====================================================================

-- +migrate Up

ALTER TABLE fleet.depots ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_fleet_depots_version
    BEFORE UPDATE ON fleet.depots
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

UPDATE fleet.depots SET code = upper(btrim(code)) WHERE code IS NOT NULL AND code <> upper(btrim(code));

DELETE FROM auth.role_permissions rp
 USING auth.roles r, auth.permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.name = 'fleet_manager' AND p.code = 'depot:write';

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'fleet_owner' AND p.code = 'depot:write'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.roles r, auth.permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.name = 'fleet_owner' AND p.code = 'depot:write';

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'fleet_manager' AND p.code = 'depot:write'
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS trg_fleet_depots_version ON fleet.depots;
ALTER TABLE fleet.depots DROP COLUMN IF EXISTS version;
