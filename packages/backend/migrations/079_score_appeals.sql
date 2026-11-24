-- =====================================================================
-- 079_score_appeals.sql
-- Driver score appeals and complaints (FMS-159, docs/score-appeals.md).
--
-- * analytics.score_appeals: a driver's appeal (or complaint) against a
--   speeding or idling flag, an incident or a month's score, with its
--   reason, explanation, status (submitted, under_review, approved,
--   rejected, closed), who claimed and decided it, the decision note and
--   correction, and the score before and after. `target_key` names what
--   it is against: one open appeal per target (ux_score_appeals_open).
--   `due_at` is the review deadline (working days, a settings parameter);
--   `escalated_at` when it went past it to the depot admin.
-- * analytics.appeal_events: every step of an appeal, with who and when;
--   comments are steps with a body. Never updated or deleted.
-- * analytics.appeal_attachments: up to 5 files per appeal (JPEG, PNG,
--   WebP or PDF, 5 MB), in the document storage under appeals/<id>/.
-- * analytics.score_exclusions: what an approved appeal took out of the
--   score: a flag, an incident or a whole trip. The facts stay; the views
--   below say whether each is excluded, and the score leaves it out.
-- * analytics.score_flag_facts and score_incident_facts: the score's flags
--   and incidents with their ids and `score_excluded`; the trip risk facts
--   (073) count no excluded flag, accident or trip as a safety event.
-- * Permissions appeal:submit (driver, and admin, who holds every one), appeal:review (fleet manager,
--   depot admin, admin) and appeal:read (those and the compliance
--   officer); the appeal window and review deadline as settings.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS analytics.score_appeals (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    driver_id         BIGINT       NOT NULL REFERENCES fleet.drivers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    -- The driver's depot when they appealed: whose queue it is in.
    depot_id          BIGINT       REFERENCES fleet.depots(id) ON DELETE SET NULL ON UPDATE CASCADE,
    kind              VARCHAR(10)  NOT NULL,
    target_type       VARCHAR(10)  NOT NULL,
    flag_id           BIGINT       REFERENCES tracking.telemetry_flags(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    incident_id       BIGINT       REFERENCES alert.incident_reports(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    -- The first day of the month, for an appeal against a month's score.
    score_month       DATE,
    -- The trip the flag or incident was on, if any: an approval may exclude it whole.
    trip_id           BIGINT       REFERENCES trip.trips(id) ON DELETE SET NULL ON UPDATE CASCADE,
    target_key        VARCHAR(80)  NOT NULL,
    -- When what is appealed happened (the end of the month for a score): the window runs from it.
    event_at          TIMESTAMPTZ  NOT NULL,
    reason            VARCHAR(20)  NOT NULL,
    explanation       VARCHAR(2000) NOT NULL,
    status            VARCHAR(15)  NOT NULL DEFAULT 'submitted',
    outcome           VARCHAR(10),
    correction        VARCHAR(20),
    decision_note     VARCHAR(2000),
    score_before      SMALLINT,
    score_after       SMALLINT,
    submitted_by      BIGINT       NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    claimed_by        BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    claimed_at        TIMESTAMPTZ,
    decided_by        BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    decided_at        TIMESTAMPTZ,
    due_at            TIMESTAMPTZ  NOT NULL,
    escalated_at      TIMESTAMPTZ,
    acknowledged_at   TIMESTAMPTZ,
    closed_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version           INTEGER      NOT NULL DEFAULT 1,
    CONSTRAINT chk_appeal_kind CHECK (kind IN ('appeal', 'complaint')),
    CONSTRAINT chk_appeal_target_type CHECK (target_type IN ('flag', 'incident', 'score')),
    CONSTRAINT chk_appeal_target CHECK (
        (target_type = 'flag' AND flag_id IS NOT NULL AND incident_id IS NULL AND score_month IS NULL)
        OR (target_type = 'incident' AND incident_id IS NOT NULL AND flag_id IS NULL AND score_month IS NULL)
        OR (target_type = 'score' AND score_month IS NOT NULL AND flag_id IS NULL AND incident_id IS NULL)),
    CONSTRAINT chk_appeal_reason CHECK (reason IN ('wrong_data', 'not_my_trip', 'road_conditions', 'vehicle_fault', 'other')),
    CONSTRAINT chk_appeal_explanation CHECK (char_length(explanation) BETWEEN 20 AND 2000),
    CONSTRAINT chk_appeal_status CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected', 'closed')),
    CONSTRAINT chk_appeal_outcome CHECK (outcome IS NULL OR outcome IN ('approved', 'rejected', 'withdrawn')),
    CONSTRAINT chk_appeal_correction CHECK (correction IS NULL OR correction IN ('exclude_flag', 'exclude_incident', 'exclude_trip')),
    -- A decision has its outcome, note, decider and time; an approval its correction.
    CONSTRAINT chk_appeal_decided CHECK (
        status NOT IN ('approved', 'rejected')
        OR (outcome = status AND decision_note IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    -- An approved appeal corrects the score; an upheld complaint may not need to.
    CONSTRAINT chk_appeal_approved_correction CHECK (outcome IS DISTINCT FROM 'approved' OR correction IS NOT NULL OR kind = 'complaint'),
    CONSTRAINT chk_appeal_closed CHECK (status <> 'closed' OR (outcome IS NOT NULL AND closed_at IS NOT NULL)),
    CONSTRAINT chk_appeal_scores CHECK (
        (score_before IS NULL OR score_before BETWEEN 0 AND 100) AND (score_after IS NULL OR score_after BETWEEN 0 AND 100))
);

-- One open appeal per flag, incident or driver's month.
CREATE UNIQUE INDEX IF NOT EXISTS ux_score_appeals_open
    ON analytics.score_appeals (target_key) WHERE status IN ('submitted', 'under_review');
-- The queue: a depot's appeals by status, oldest first.
CREATE INDEX IF NOT EXISTS idx_score_appeals_queue ON analytics.score_appeals (depot_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_score_appeals_driver ON analytics.score_appeals (driver_id, created_at DESC);
-- The jobs: undecided past their deadline, decided and not yet closed.
CREATE INDEX IF NOT EXISTS idx_score_appeals_due ON analytics.score_appeals (due_at)
    WHERE status IN ('submitted', 'under_review') AND escalated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_score_appeals_decided ON analytics.score_appeals (decided_at)
    WHERE status IN ('approved', 'rejected');

CREATE OR REPLACE TRIGGER trg_score_appeals_updated_at
    BEFORE UPDATE ON analytics.score_appeals
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_score_appeals_version
    BEFORE UPDATE ON analytics.score_appeals
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

CREATE TABLE IF NOT EXISTS analytics.appeal_events (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    appeal_id      BIGINT       NOT NULL REFERENCES analytics.score_appeals(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    event_type     VARCHAR(20)  NOT NULL,
    -- Null for the system (the escalation and closing jobs).
    actor_user_id  BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    body           VARCHAR(2000),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_appeal_event_type CHECK (event_type IN (
        'submitted', 'claimed', 'commented', 'approved', 'rejected', 'withdrawn', 'escalated', 'acknowledged', 'closed', 'attachment_opened')),
    CONSTRAINT chk_appeal_event_comment CHECK (event_type <> 'commented' OR body IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_appeal_events_appeal ON analytics.appeal_events (appeal_id, id);

CREATE TABLE IF NOT EXISTS analytics.appeal_attachments (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    appeal_id          BIGINT       NOT NULL REFERENCES analytics.score_appeals(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    storage_key        VARCHAR(200) NOT NULL UNIQUE,
    content_type       VARCHAR(30)  NOT NULL,
    size_bytes         INTEGER      NOT NULL,
    sha256             CHAR(64)     NOT NULL,
    original_filename  VARCHAR(255),
    uploaded_by        BIGINT       NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_appeal_attachment_type CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    CONSTRAINT chk_appeal_attachment_size CHECK (size_bytes BETWEEN 1 AND 5242880)
);
CREATE INDEX IF NOT EXISTS idx_appeal_attachments_appeal ON analytics.appeal_attachments (appeal_id, id);

CREATE TABLE IF NOT EXISTS analytics.score_exclusions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    appeal_id       BIGINT       NOT NULL UNIQUE REFERENCES analytics.score_appeals(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    exclusion_type  VARCHAR(10)  NOT NULL,
    flag_id         BIGINT       REFERENCES tracking.telemetry_flags(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    incident_id     BIGINT       REFERENCES alert.incident_reports(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    trip_id         BIGINT       REFERENCES trip.trips(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    created_by      BIGINT       NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_score_exclusion_type CHECK (
        (exclusion_type = 'flag' AND flag_id IS NOT NULL AND incident_id IS NULL AND trip_id IS NULL)
        OR (exclusion_type = 'incident' AND incident_id IS NOT NULL AND flag_id IS NULL AND trip_id IS NULL)
        OR (exclusion_type = 'trip' AND trip_id IS NOT NULL AND flag_id IS NULL AND incident_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_score_exclusions_flag ON analytics.score_exclusions (flag_id) WHERE flag_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_score_exclusions_incident ON analytics.score_exclusions (incident_id) WHERE incident_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_score_exclusions_trip ON analytics.score_exclusions (trip_id) WHERE trip_id IS NOT NULL;

-- The score's flags and incidents (it reads the 054 views for the rest), each with its ids and whether an approved
-- appeal took it out of the score: on its own, or with the whole trip it was on. An excluded trip itself is a row
-- of score_exclusions the score's query checks.
CREATE OR REPLACE VIEW analytics.score_flag_facts AS
SELECT
    f.id AS flag_id,
    f.public_id,
    f.vehicle_id,
    f.trip_id,
    t.driver_id,
    f.flag_type,
    f.observed_at,
    f.resolved_at,
    f.reviewed_by,
    (EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.flag_id = f.id)
     OR EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.trip_id = f.trip_id)) AS score_excluded
FROM tracking.telemetry_flags f
LEFT JOIN trip.trips t ON t.id = f.trip_id;

CREATE OR REPLACE VIEW analytics.score_incident_facts AS
SELECT
    i.id AS incident_id,
    i.public_id,
    i.vehicle_id,
    i.trip_id,
    i.driver_id,
    i.incident_type::text AS incident_type,
    i.occurred_at,
    i.reported_by,
    (EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.incident_id = i.id)
     OR EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.trip_id = i.trip_id)) AS score_excluded
FROM alert.incident_reports i;

-- The trip risk model's labels (073): a flag or accident an approved appeal excluded is no safety event.
CREATE OR REPLACE VIEW analytics.trip_risk_facts AS
SELECT
    t.id AS trip_id,
    t.public_id,
    t.driver_id,
    d.public_id AS driver_public_id,
    t.route_id,
    r.depot_id,
    dp.public_id AS depot_public_id,
    t.status::text AS status,
    t.scheduled_start,
    t.scheduled_end,
    t.actual_start,
    t.actual_end,
    t.planned_distance_km::float8 AS planned_distance_km,
    t.planned_duration_seconds,
    (SELECT count(*)::int FROM trip.trip_stops s WHERE s.trip_id = t.id) AS stop_count,
    t.cargo_weight_kg::float8 AS cargo_weight_kg,
    t.cargo_kind,
    v.payload_capacity_kg::float8 AS payload_capacity_kg,
    t.actual_distance_source IS NOT NULL AS measured,
    CASE
        WHEN t.status::text <> 'completed' OR t.scheduled_end IS NULL OR t.actual_end IS NULL THEN NULL
        ELSE t.actual_end > t.scheduled_end + make_interval(mins => COALESCE(
            (SELECT th.trip_delay_minutes FROM tracking.rule_thresholds th WHERE th.depot_id = r.depot_id),
            (SELECT th.trip_delay_minutes FROM tracking.rule_thresholds th WHERE th.depot_id IS NULL ORDER BY th.id LIMIT 1),
            15))
    END AS late,
    (t.actual_start IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.trip_id = t.id)
     AND (
        EXISTS (
            SELECT 1 FROM tracking.telemetry_flags f
             WHERE f.trip_id = t.id AND f.flag_type = 'speeding'
               AND NOT EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.flag_id = f.id))
        OR EXISTS (
            SELECT 1 FROM alert.incident_reports i
             WHERE i.driver_id = t.driver_id AND i.incident_type = 'accident'
               AND i.occurred_at >= t.actual_start AND i.occurred_at <= COALESCE(t.actual_end, now())
               AND NOT EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.incident_id = i.id))
    )) AS safety_event
FROM trip.trips t
LEFT JOIN fleet.drivers d ON d.id = t.driver_id
LEFT JOIN trip.routes r ON r.id = t.route_id
LEFT JOIN fleet.depots dp ON dp.id = r.depot_id
LEFT JOIN fleet.vehicles v ON v.id = t.vehicle_id;

-- A driver's own notices that are no alert (an appeal's question or decision): what they are about, so the inbox and
-- a push open it.
ALTER TABLE alert.notifications
    ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS entity_id VARCHAR(64);

INSERT INTO auth.permissions (code, description) VALUES
    ('appeal:submit', 'Appeal or complain about one''s own score, flags and incidents'),
    ('appeal:review', 'Claim, discuss and decide drivers'' score appeals'),
    ('appeal:read', 'Read drivers'' score appeals and their evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r JOIN auth.permissions p ON
    -- The admin holds every permission, so may create and change drivers' accounts (no role beyond what one holds).
    (p.code = 'appeal:submit' AND r.name IN ('driver', 'admin'))
    OR (p.code = 'appeal:review' AND r.name IN ('admin', 'fleet_manager', 'depot_admin'))
    OR (p.code = 'appeal:read' AND r.name IN ('admin', 'fleet_manager', 'depot_admin', 'compliance_officer'))
ON CONFLICT DO NOTHING;

INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('appeal_window_days', 'Appeal window', 'Score appeals',
     'Days after a flag, an incident or the end of a month in which a driver may appeal it.',
     'integer', '30', '{"min": 1, "max": 365, "unit": "days"}', TRUE, 'settings'),
    ('appeal_review_working_days', 'Review deadline', 'Score appeals',
     'Working days, Monday to Friday, to decide an appeal before it is overdue and goes to the depot admin.',
     'integer', '5', '{"min": 1, "max": 30, "unit": "working days"}', TRUE, 'settings')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        -- Appeals and their steps are never deleted.
        GRANT SELECT, INSERT, UPDATE ON analytics.score_appeals TO fms_app;
        GRANT SELECT, INSERT ON analytics.appeal_events, analytics.appeal_attachments, analytics.score_exclusions TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA analytics TO fms_app;
    END IF;
END $$;

-- +migrate Down

DELETE FROM settings.settings WHERE key IN ('appeal_window_days', 'appeal_review_working_days');
DELETE FROM settings.definitions WHERE key IN ('appeal_window_days', 'appeal_review_working_days');
DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code IN ('appeal:submit', 'appeal:review', 'appeal:read');
DELETE FROM auth.permissions WHERE code IN ('appeal:submit', 'appeal:review', 'appeal:read');

DELETE FROM alert.notifications WHERE alert_id IS NULL AND entity_type = 'appeal';
ALTER TABLE alert.notifications DROP COLUMN IF EXISTS entity_id, DROP COLUMN IF EXISTS entity_type;

-- The trip risk facts as 073 left them (the same columns), and the score's views gone.
CREATE OR REPLACE VIEW analytics.trip_risk_facts AS
SELECT
    t.id AS trip_id,
    t.public_id,
    t.driver_id,
    d.public_id AS driver_public_id,
    t.route_id,
    r.depot_id,
    dp.public_id AS depot_public_id,
    t.status::text AS status,
    t.scheduled_start,
    t.scheduled_end,
    t.actual_start,
    t.actual_end,
    t.planned_distance_km::float8 AS planned_distance_km,
    t.planned_duration_seconds,
    (SELECT count(*)::int FROM trip.trip_stops s WHERE s.trip_id = t.id) AS stop_count,
    t.cargo_weight_kg::float8 AS cargo_weight_kg,
    t.cargo_kind,
    v.payload_capacity_kg::float8 AS payload_capacity_kg,
    t.actual_distance_source IS NOT NULL AS measured,
    CASE
        WHEN t.status::text <> 'completed' OR t.scheduled_end IS NULL OR t.actual_end IS NULL THEN NULL
        ELSE t.actual_end > t.scheduled_end + make_interval(mins => COALESCE(
            (SELECT th.trip_delay_minutes FROM tracking.rule_thresholds th WHERE th.depot_id = r.depot_id),
            (SELECT th.trip_delay_minutes FROM tracking.rule_thresholds th WHERE th.depot_id IS NULL ORDER BY th.id LIMIT 1),
            15))
    END AS late,
    (t.actual_start IS NOT NULL AND (
        EXISTS (SELECT 1 FROM tracking.telemetry_flags f WHERE f.trip_id = t.id AND f.flag_type = 'speeding')
        OR EXISTS (
            SELECT 1 FROM alert.incident_reports i
             WHERE i.driver_id = t.driver_id AND i.incident_type = 'accident'
               AND i.occurred_at >= t.actual_start AND i.occurred_at <= COALESCE(t.actual_end, now()))
    )) AS safety_event
FROM trip.trips t
LEFT JOIN fleet.drivers d ON d.id = t.driver_id
LEFT JOIN trip.routes r ON r.id = t.route_id
LEFT JOIN fleet.depots dp ON dp.id = r.depot_id
LEFT JOIN fleet.vehicles v ON v.id = t.vehicle_id;

DROP VIEW IF EXISTS analytics.score_incident_facts;
DROP VIEW IF EXISTS analytics.score_flag_facts;

DROP TABLE IF EXISTS analytics.score_exclusions;
DROP TABLE IF EXISTS analytics.appeal_attachments;
DROP TABLE IF EXISTS analytics.appeal_events;
DROP TABLE IF EXISTS analytics.score_appeals;
