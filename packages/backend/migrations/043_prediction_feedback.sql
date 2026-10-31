-- =====================================================================
-- 043_prediction_feedback.sql
-- What a technician found when they inspected a flagged vehicle (FMS-128).
--
-- * prediction_feedback: one row per prediction (uq on prediction_id): who
--   inspected, the outcome (confirmed_issue, no_issue_found,
--   already_fixed, not_inspected), the component found and the failure
--   record it led to (both only for a confirmed issue), a comment. The
--   author may edit it for 7 days (enforced by the API); nobody deletes
--   it, so the model's measured precision cannot be tidied away.
-- * The confirmed share of high-risk predictions per model version is read
--   from here (GET /ml-models, FMS-127).
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE maintenance.prediction_outcome AS ENUM
        ('confirmed_issue', 'no_issue_found', 'already_fixed', 'not_inspected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.prediction_feedback (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    prediction_id    BIGINT NOT NULL REFERENCES maintenance.maintenance_predictions(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    user_id          BIGINT NOT NULL REFERENCES auth.users(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    outcome          maintenance.prediction_outcome NOT NULL,
    component        maintenance.failure_component,
    failure_event_id BIGINT REFERENCES maintenance.failure_events(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    comment          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_prediction_feedback_prediction UNIQUE (prediction_id),
    -- What was found, and the failure it led to, only mean something for a confirmed issue.
    CONSTRAINT chk_prediction_feedback_found
        CHECK (outcome = 'confirmed_issue' OR (component IS NULL AND failure_event_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_prediction_feedback_failure
    ON maintenance.prediction_feedback(failure_event_id)
    WHERE failure_event_id IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_prediction_feedback_updated_at
    BEFORE UPDATE ON maintenance.prediction_feedback
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- +migrate Down

DROP TRIGGER IF EXISTS trg_prediction_feedback_updated_at ON maintenance.prediction_feedback;
DROP TABLE IF EXISTS maintenance.prediction_feedback;
DROP TYPE IF EXISTS maintenance.prediction_outcome;
