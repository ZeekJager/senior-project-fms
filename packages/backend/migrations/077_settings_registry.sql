-- =====================================================================
-- 077_settings_registry.sql
-- Dynamic settings management (FMS-157, ADR-09, docs/settings.md).
--
-- * settings.definitions: the registry, one row per system parameter: its
--   key, label, category, description, type (text, number, integer,
--   boolean, dropdown, multi_select, duration, email, url or json), typed
--   default (jsonb) and rules (range, options, pattern, JSON Schema), and
--   whether it is enabled, a system parameter, secret, and needs a named
--   permission besides settings:write to change. A disabled parameter
--   answers with its default. Custom parameters are added and soft deleted
--   (is_active) by settings:define; system ones are declared in code (the
--   API keeps their label, rules and default in step on start) and are
--   never deleted (chk_definitions_system_kept). `version` is bumped on
--   every change of the definition or its value: the parameter's ETag.
-- * storage: where the value lives. `settings` is settings.settings;
--   `rule_thresholds` is the fleet's row of tracking.rule_thresholds,
--   where the driving rules' thresholds stay (each depot's own row still
--   overrides them), so nothing about how they apply changes. Its new
--   change_reason keeps why the last change was made, so the audit row of
--   a change has it.
-- * settings.settings.value becomes jsonb (every value was a whole
--   number, so each stays the same number), with secret_value for secret
--   parameters, never copied into the audit trail, and the reason given
--   for the change.
-- * The 7 settings and the 15 thresholds become system parameters, with
--   their values where they were.
-- * settings:define (admin only): add, delete, enable and disable
--   parameters. settings:write still changes values.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS settings.definitions (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key                  VARCHAR(80) NOT NULL,
    label                VARCHAR(120) NOT NULL,
    category             VARCHAR(60) NOT NULL,
    description          VARCHAR(1000) NOT NULL DEFAULT '',
    type                 VARCHAR(20) NOT NULL,
    default_value        JSONB NOT NULL,
    rules                JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    is_system            BOOLEAN NOT NULL DEFAULT FALSE,
    is_secret            BOOLEAN NOT NULL DEFAULT FALSE,
    -- Needed besides settings:write to change the value.
    required_permission  VARCHAR(100) REFERENCES auth.permissions(code)
                         ON DELETE RESTRICT ON UPDATE CASCADE,
    storage              VARCHAR(20) NOT NULL DEFAULT 'settings',
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    -- When the value last changed; the definition's own changes are updated_at.
    value_changed_at     TIMESTAMPTZ,
    version              INTEGER NOT NULL DEFAULT 1,
    created_by           BIGINT REFERENCES auth.users(id)
                         ON DELETE SET NULL ON UPDATE CASCADE,
    updated_by           BIGINT REFERENCES auth.users(id)
                         ON DELETE SET NULL ON UPDATE CASCADE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_definitions_key CHECK (key ~ '^[a-z][a-z0-9_]{1,79}$'),
    CONSTRAINT chk_definitions_type CHECK (type IN (
        'text', 'number', 'integer', 'boolean', 'dropdown', 'multi_select', 'duration', 'email', 'url', 'json')),
    CONSTRAINT chk_definitions_rules CHECK (jsonb_typeof(rules) = 'object'),
    CONSTRAINT chk_definitions_storage CHECK (storage IN ('settings', 'rule_thresholds')),
    -- Only system parameters live outside settings.settings, and none is ever deleted.
    CONSTRAINT chk_definitions_custom_storage CHECK (is_system OR storage = 'settings'),
    CONSTRAINT chk_definitions_system_kept CHECK (is_active OR NOT is_system)
);

-- One live definition per key; a deleted custom parameter's key may be used again.
CREATE UNIQUE INDEX IF NOT EXISTS ux_settings_definitions_key
    ON settings.definitions(key) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_settings_definitions_category
    ON settings.definitions(category, label) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_settings_definitions_updated_at
    BEFORE UPDATE ON settings.definitions
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_settings_definitions_version
    BEFORE UPDATE ON settings.definitions
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

-- Every value was a whole number: each stays the same number, now as jsonb.
ALTER TABLE settings.settings
    ALTER COLUMN value TYPE JSONB USING to_jsonb(value);

ALTER TABLE settings.settings
    ADD COLUMN IF NOT EXISTS secret_value JSONB,
    ADD COLUMN IF NOT EXISTS reason VARCHAR(500);

ALTER TABLE tracking.rule_thresholds
    ADD COLUMN IF NOT EXISTS change_reason VARCHAR(500);

-- The system parameters, as the code declares them (the API keeps them in step on start).
INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('fuel_variance_threshold_pct', 'Fuel variance', 'Alerts and anomalies',
     'A vehicle''s month of fuel this far above or below what its trips needed is an anomaly.',
     'integer', '20', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('health_alert_below', 'Health score alert line', 'Alerts and anomalies',
     'Below this a technician is alerted and the vehicle shows At risk. Healthy starts at 85.',
     'integer', '75', '{"min": 50, "max": 84, "unit": "score"}', TRUE, 'settings'),
    ('expiry_warning_days', 'Expiry warning', 'Alerts and anomalies',
     'The first warning for a document or driving licence; the red one stays at 7 days.',
     'integer', '30', '{"min": 8, "max": 180, "unit": "days"}', TRUE, 'settings'),
    ('driver_score_weight_punctuality', 'Punctuality', 'Driver score',
     'How much trips ended within 15 minutes of their scheduled end count in the driver score.',
     'integer', '35', '{"min": 0, "max": 100, "unit": "weight"}', TRUE, 'settings'),
    ('driver_score_weight_safety', 'Safety', 'Driver score',
     'How much speeding and idling per 100 km count in the driver score.',
     'integer', '35', '{"min": 0, "max": 100, "unit": "weight"}', TRUE, 'settings'),
    ('driver_score_weight_incidents', 'Incidents', 'Driver score',
     'How much accidents per 100 km count in the driver score.',
     'integer', '20', '{"min": 0, "max": 100, "unit": "weight"}', TRUE, 'settings'),
    ('driver_score_weight_dvir', 'Inspections', 'Driver score',
     'How much completed trips with the driver''s pre-trip inspection count in the driver score.',
     'integer', '10', '{"min": 0, "max": 100, "unit": "weight"}', TRUE, 'settings'),
    ('speed_limit_kmh', 'Speed limit', 'Driving rules',
     'Exactly the limit is not speeding. A depot can have its own.',
     'integer', '80', '{"min": 20, "max": 200, "unit": "km/h"}', TRUE, 'rule_thresholds'),
    ('speeding_pings', 'Speeding after', 'Driving rules',
     'Pings in a row over the limit. A ping comes about every 10 s.',
     'integer', '3', '{"min": 1, "max": 20, "unit": "pings"}', TRUE, 'rule_thresholds'),
    ('clear_pings', 'Cleared after', 'Driving rules',
     'Pings in a row at or under the limit, or back on the route.',
     'integer', '3', '{"min": 1, "max": 20, "unit": "pings"}', TRUE, 'rule_thresholds'),
    ('idle_minutes', 'Idling after', 'Driving rules',
     'Minutes at 0 km/h with the engine not reported off.',
     'integer', '5', '{"min": 1, "max": 120, "unit": "min"}', TRUE, 'rule_thresholds'),
    ('route_deviation_m', 'Off route beyond', 'Driving rules',
     'Metres from the trip’s road. GPS drifts 10 to 50 m.',
     'integer', '500', '{"min": 100, "max": 5000, "unit": "m"}', TRUE, 'rule_thresholds'),
    ('route_deviation_pings', 'Off route after', 'Driving rules',
     'Pings in a row that far out.',
     'integer', '3', '{"min": 1, "max": 20, "unit": "pings"}', TRUE, 'rule_thresholds'),
    ('trip_delay_minutes', 'Trip late after', 'Trip delays',
     'Minutes a trip is expected past its scheduled end before dispatchers are told.',
     'integer', '15', '{"min": 5, "max": 240, "unit": "min"}', TRUE, 'rule_thresholds'),
    ('trip_delay_urgent_minutes', 'Trip urgent after', 'Trip delays',
     'Minutes past its end before they are told again by email, SMS and push. Later than late.',
     'integer', '60', '{"min": 10, "max": 720, "unit": "min"}', TRUE, 'rule_thresholds'),
    ('driver_attendance_exception', 'Driver marked absent', 'Assignment',
     'Assigning a driver who is absent, on leave or sick on the trip’s day.',
     'dropdown', '"warn"', '{"options": [{"value": "warn", "label": "Warn, then assign"}, {"value": "approve", "label": "Needs a fleet manager’s approval"}]}', TRUE, 'rule_thresholds'),
    ('trip_overrun_exception', 'Previous trip running over', 'Assignment',
     'Assigning a driver or vehicle whose trip still under way runs into this one.',
     'dropdown', '"warn"', '{"options": [{"value": "warn", "label": "Warn, then assign"}, {"value": "approve", "label": "Needs a fleet manager’s approval"}]}', TRUE, 'rule_thresholds'),
    ('daily_distance_km', 'Daily limit', 'Distance limits',
     'Load-weighted km a driver may be given in a calendar day in Addis Ababa.',
     'integer', '500', '{"min": 50, "max": 2000, "unit": "km"}', TRUE, 'rule_thresholds'),
    ('weekly_distance_km', 'Weekly limit', 'Distance limits',
     'Load-weighted km a driver may be given Monday to Sunday. At least the daily limit.',
     'integer', '2500', '{"min": 100, "max": 10000, "unit": "km"}', TRUE, 'rule_thresholds'),
    ('distance_weight_light', 'Light job', 'Distance limits',
     'What a km of a light job counts for: short, few stops, little cargo.',
     'number', '0.8', '{"min": 0.5, "max": 3, "decimals": 2, "unit": "×"}', TRUE, 'rule_thresholds'),
    ('distance_weight_standard', 'Standard job', 'Distance limits',
     'What a km of a standard job counts for.',
     'number', '1', '{"min": 0.5, "max": 3, "decimals": 2, "unit": "×"}', TRUE, 'rule_thresholds'),
    ('distance_weight_heavy', 'Heavy job', 'Distance limits',
     'What a km of a heavy job counts for: long haul, long hours, night, near payload. Never less than standard.',
     'number', '1.5', '{"min": 0.5, "max": 3, "decimals": 2, "unit": "×"}', TRUE, 'rule_thresholds')
ON CONFLICT (key) WHERE is_active DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        -- No DELETE: a custom parameter is deleted with is_active, audited like any change.
        GRANT SELECT, INSERT, UPDATE ON settings.definitions TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA settings TO fms_app;
    END IF;
END $$;

INSERT INTO auth.permissions (code, description) VALUES
    ('settings:define', 'Add, delete, enable and disable settings parameters')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'admin' AND p.code = 'settings:define'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'settings:define';
DELETE FROM auth.permissions WHERE code = 'settings:define';

-- Only the system settings' whole numbers go back; custom parameters' values go with the registry.
DELETE FROM settings.settings s
 WHERE NOT EXISTS (
     SELECT 1 FROM settings.definitions d
      WHERE d.key = s.key AND d.is_system AND d.storage = 'settings' AND d.type = 'integer');
UPDATE settings.settings SET value = NULL WHERE value IS NOT NULL AND jsonb_typeof(value) <> 'number';
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS change_reason;
ALTER TABLE settings.settings
    DROP COLUMN IF EXISTS secret_value,
    DROP COLUMN IF EXISTS reason;
ALTER TABLE settings.settings
    ALTER COLUMN value TYPE INTEGER USING (value #>> '{}')::numeric::integer;

DROP TABLE IF EXISTS settings.definitions;
