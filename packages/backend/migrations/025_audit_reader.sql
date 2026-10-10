-- =====================================================================
-- 025_audit_reader.sql
-- Audit log reader API (FMS-28).
--
-- Indexes for GET /audit-logs: newest first with (created_at, id) as the
-- cursor, and lookup by the entity's public id, which mutations store in
-- their old/new values (the API never takes internal ids).
--
-- audit:read is admin, fleet_owner and compliance_officer (the card and
-- screen inventory S-10); 001 also gave it to fleet_manager, which loses it.
-- =====================================================================

-- +migrate Up

CREATE INDEX IF NOT EXISTS idx_audit_logs_recent
    ON audit.audit_logs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_public
    ON audit.audit_logs ((COALESCE(new_values->>'public_id', old_values->>'public_id')), created_at DESC, id DESC);

DELETE FROM auth.role_permissions rp
 USING auth.roles r, auth.permissions p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.name = 'fleet_manager' AND p.code = 'audit:read';

-- +migrate Down

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'fleet_manager' AND p.code = 'audit:read'
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS audit.idx_audit_logs_entity_public;
DROP INDEX IF EXISTS audit.idx_audit_logs_recent;
