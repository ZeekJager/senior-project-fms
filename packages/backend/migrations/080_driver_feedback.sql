-- =====================================================================
-- 080_driver_feedback.sql
-- Admin-to-driver feedback (FMS-158, docs/driver-feedback.md).
--
-- * analytics.driver_feedback: a manager's feedback to a driver on a
--   trip, a month (with the score shown then) or their performance
--   overall: category (a settings parameter's options), tone, message,
--   author. Editable by its author for 24 hours (`editable_until`);
--   after that only retracted, with a reason: a retracted item is gone
--   for the driver and stays here and in the audit log. The driver
--   acknowledges it and may reply once.
-- * analytics.feedback_revisions: the earlier text of an edited item.
-- * analytics.feedback_templates: saved messages per category.
-- * analytics.score_appeals.feedback_id: the feedback an appeal disagrees
--   with ("I disagree", FMS-159): its author may not decide the appeal.
-- * Permissions feedback:write and feedback:read (admin, fleet manager,
--   depot admin); privacy:erase (admin) erases a driver's personal data
--   that the modules hold for erasure (feedback, for now).
-- * Settings feedback_categories (multi-select) and
--   feedback_retention_months (24).
-- * Grants: feedback is deleted by its retention job and by an erasure,
--   so fms_app holds DELETE on it (and its revisions go with it).
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS analytics.driver_feedback (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    -- An erased driver's feedback goes with them (the erasure deletes it first; this is the backstop).
    driver_id          BIGINT        NOT NULL REFERENCES fleet.drivers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    -- The driver's depot when it was given: whose managers read it.
    depot_id           BIGINT        REFERENCES fleet.depots(id) ON DELETE SET NULL ON UPDATE CASCADE,
    subject_type       VARCHAR(10)   NOT NULL,
    trip_id            BIGINT        REFERENCES trip.trips(id) ON DELETE SET NULL ON UPDATE CASCADE,
    -- The first day of the month, for feedback on a month's score, and the score the author saw.
    score_month        DATE,
    score_shown        SMALLINT,
    category           VARCHAR(40)   NOT NULL,
    tone               VARCHAR(20)   NOT NULL,
    message            VARCHAR(2000) NOT NULL,
    author_id          BIGINT        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    editable_until     TIMESTAMPTZ   NOT NULL,
    edited_at          TIMESTAMPTZ,
    retracted_at       TIMESTAMPTZ,
    retracted_by       BIGINT        REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    retraction_reason  VARCHAR(500),
    acknowledged_at    TIMESTAMPTZ,
    reply              VARCHAR(1000),
    replied_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version            INTEGER       NOT NULL DEFAULT 1,
    CONSTRAINT chk_feedback_subject_type CHECK (subject_type IN ('trip', 'month', 'overall')),
    -- A trip's feedback names it while the trip exists; a month's has its month; overall has neither.
    CONSTRAINT chk_feedback_subject CHECK (
        (subject_type = 'trip' AND score_month IS NULL)
        OR (subject_type = 'month' AND score_month IS NOT NULL AND trip_id IS NULL)
        OR (subject_type = 'overall' AND score_month IS NULL AND trip_id IS NULL)),
    CONSTRAINT chk_feedback_tone CHECK (tone IN ('praise', 'needs_improvement', 'information')),
    CONSTRAINT chk_feedback_message CHECK (char_length(message) BETWEEN 10 AND 2000),
    CONSTRAINT chk_feedback_reply CHECK ((reply IS NULL) = (replied_at IS NULL) AND (reply IS NULL OR char_length(reply) BETWEEN 1 AND 1000)),
    CONSTRAINT chk_feedback_retracted CHECK (
        (retracted_at IS NULL AND retraction_reason IS NULL)
        OR (retracted_at IS NOT NULL AND char_length(retraction_reason) BETWEEN 1 AND 500))
);

CREATE INDEX IF NOT EXISTS idx_driver_feedback_driver ON analytics.driver_feedback (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_feedback_created ON analytics.driver_feedback (created_at);

CREATE OR REPLACE TRIGGER trg_driver_feedback_updated_at
    BEFORE UPDATE ON analytics.driver_feedback
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_driver_feedback_version
    BEFORE UPDATE ON analytics.driver_feedback
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE TABLE IF NOT EXISTS analytics.feedback_revisions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feedback_id  BIGINT        NOT NULL REFERENCES analytics.driver_feedback(id) ON DELETE CASCADE ON UPDATE CASCADE,
    -- The text before the edit.
    message      VARCHAR(2000) NOT NULL,
    revised_by   BIGINT        REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_revisions_feedback ON analytics.feedback_revisions (feedback_id, id);

CREATE TABLE IF NOT EXISTS analytics.feedback_templates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id   UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    category    VARCHAR(40)   NOT NULL,
    title       VARCHAR(80)   NOT NULL,
    body        VARCHAR(2000) NOT NULL,
    is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
    created_by  BIGINT        REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    updated_by  BIGINT        REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version     INTEGER       NOT NULL DEFAULT 1,
    CONSTRAINT chk_feedback_template_title CHECK (char_length(title) BETWEEN 1 AND 80),
    CONSTRAINT chk_feedback_template_body CHECK (char_length(body) BETWEEN 10 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_feedback_templates_category ON analytics.feedback_templates (category, title) WHERE is_active;

CREATE OR REPLACE TRIGGER trg_feedback_templates_updated_at
    BEFORE UPDATE ON analytics.feedback_templates
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_feedback_templates_version
    BEFORE UPDATE ON analytics.feedback_templates
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

-- "I disagree" on feedback opens an appeal that names it (FMS-159): its author may not decide that appeal.
ALTER TABLE analytics.score_appeals
    ADD COLUMN IF NOT EXISTS feedback_id BIGINT REFERENCES analytics.driver_feedback(id) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO auth.permissions (code, description) VALUES
    ('feedback:write', 'Give drivers feedback, correct and retract it, and keep its templates'),
    ('feedback:read', 'Read the feedback given to drivers'),
    ('privacy:erase', 'Erase a driver''s personal data held for erasure')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r JOIN auth.permissions p ON
    (p.code IN ('feedback:write', 'feedback:read') AND r.name IN ('admin', 'fleet_manager', 'depot_admin'))
    OR (p.code = 'privacy:erase' AND r.name = 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('feedback_categories', 'Feedback categories', 'Driver feedback',
     'The categories a manager files feedback under. At least one.',
     'multi_select',
     '["safety", "driving_behaviour", "fuel_efficiency", "punctuality", "vehicle_care", "general"]',
     '{"options": [{"value": "safety", "label": "Safety"}, {"value": "driving_behaviour", "label": "Driving behaviour"}, {"value": "fuel_efficiency", "label": "Fuel efficiency"}, {"value": "punctuality", "label": "Punctuality"}, {"value": "vehicle_care", "label": "Vehicle care"}, {"value": "general", "label": "General comment"}], "min_items": 1}',
     TRUE, 'settings'),
    ('feedback_retention_months', 'Feedback kept', 'Driver feedback',
     'Months feedback is kept, retracted items too; older items are deleted each night.',
     'integer', '24', '{"min": 1, "max": 120, "unit": "months"}', TRUE, 'settings')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        -- Deleted only by the retention job and an erasure; the revisions go with their item.
        GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.driver_feedback TO fms_app;
        GRANT SELECT, INSERT, DELETE ON analytics.feedback_revisions TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON analytics.feedback_templates TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA analytics TO fms_app;
    END IF;
END $$;

-- +migrate Down

DELETE FROM settings.settings WHERE key IN ('feedback_categories', 'feedback_retention_months');
DELETE FROM settings.definitions WHERE key IN ('feedback_categories', 'feedback_retention_months');
DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code IN ('feedback:write', 'feedback:read', 'privacy:erase');
DELETE FROM auth.permissions WHERE code IN ('feedback:write', 'feedback:read', 'privacy:erase');

DELETE FROM alert.notifications WHERE alert_id IS NULL AND entity_type = 'feedback';

ALTER TABLE analytics.score_appeals DROP COLUMN IF EXISTS feedback_id;
DROP TABLE IF EXISTS analytics.feedback_templates;
DROP TABLE IF EXISTS analytics.feedback_revisions;
DROP TABLE IF EXISTS analytics.driver_feedback;
