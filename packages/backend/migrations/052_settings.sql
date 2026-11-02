-- =====================================================================
-- 052_settings.sql
-- Settings an administrator tunes without a code change (FMS-80, CFG-3,
-- docs/settings.md).
--
-- * settings.settings: one row per setting an administrator has changed;
--   value NULL (or no row) means the default in code. Owned by the
--   settings module. Whole numbers only: every threshold is one.
-- * settings:write (admin only) for these and the telemetry rules'
--   thresholds (tracking.rule_thresholds, 035), which keep their table.
--   Anyone signed in reads them: the screens show the lines they draw.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS settings;
REVOKE CREATE ON SCHEMA settings FROM PUBLIC;

CREATE TABLE IF NOT EXISTS settings.settings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key         VARCHAR(80) NOT NULL,
    -- NULL: back to the default.
    value       INTEGER,
    updated_by  BIGINT REFERENCES auth.users(id)
                ON DELETE SET NULL ON UPDATE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_settings_key UNIQUE (key),
    CONSTRAINT chk_settings_key CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

CREATE OR REPLACE TRIGGER trg_settings_settings_updated_at
    BEFORE UPDATE ON settings.settings
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA settings TO fms_app;
        -- No DELETE: a setting goes back to its default with value NULL, audited like any change.
        GRANT SELECT, INSERT, UPDATE ON settings.settings TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA settings TO fms_app;
    END IF;
END $$;

INSERT INTO auth.permissions (code, description) VALUES
    ('settings:write', 'Change rule thresholds and other settings')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'admin' AND p.code = 'settings:write'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'settings:write';
DELETE FROM auth.permissions WHERE code = 'settings:write';
DROP TABLE IF EXISTS settings.settings;
DROP SCHEMA IF EXISTS settings;
