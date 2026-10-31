-- =====================================================================
-- 039_ml_models.sql
-- The model registry (FMS-127): every predictive maintenance model the
-- system has used, so each score can be traced to the model, data and
-- metrics behind it.
--
-- * ml_models: one row per model version the ML service (FMS-54) has
--   served, recorded the first time the scoring job sees it (GET /model):
--   its inputs, the SHA-256 of the feature spec they were computed by,
--   metrics, training data, artefact checksum. Never edited, except its
--   status: registered (seen, not yet allowed to score), active (the one
--   that scores; at most one per model name), retired (replaced). An
--   administrator activates a model; activating one retires the other.
-- * maintenance_predictions: every prediction names a registered model
--   (model_name, model_version); a version the registry does not hold
--   cannot be stored.
-- * ml-model:activate: allowing a model to score, for administrators.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE maintenance.ml_model_status AS ENUM ('registered', 'active', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS maintenance.ml_models (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id             UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    name                  VARCHAR(100) NOT NULL,
    version               VARCHAR(100) NOT NULL,
    algorithm             TEXT NOT NULL,
    -- The model's inputs, in the order it takes them.
    features              JSONB NOT NULL,
    feature_spec_version  INTEGER NOT NULL CHECK (feature_spec_version > 0),
    -- SHA-256 (hex) of the canonical feature definitions (feature_spec.json).
    feature_spec_hash     CHAR(64) NOT NULL CHECK (feature_spec_hash ~ '^[0-9a-f]{64}$'),
    -- Precision, recall, F1 at the alert line, ROC-AUC and the rest, measured on held-out vehicles.
    metrics               JSONB NOT NULL,
    -- Which data: file and its hash, rows, vehicles, dates, split.
    training_data         JSONB NOT NULL,
    trained_at            TIMESTAMPTZ NOT NULL,
    artefact_sha256       CHAR(64) NOT NULL CHECK (artefact_sha256 ~ '^[0-9a-f]{64}$'),
    status                maintenance.ml_model_status NOT NULL DEFAULT 'registered',
    -- When the scoring job first saw the service serve it.
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at          TIMESTAMPTZ,
    activated_by          BIGINT REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    retired_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_ml_models_name_version UNIQUE (name, version),
    CONSTRAINT chk_ml_models_features CHECK (jsonb_typeof(features) = 'array' AND jsonb_array_length(features) > 0),
    CONSTRAINT chk_ml_models_metrics CHECK (jsonb_typeof(metrics) = 'object'),
    CONSTRAINT chk_ml_models_training_data CHECK (jsonb_typeof(training_data) = 'object'),
    CONSTRAINT chk_ml_models_activated CHECK (status <> 'active' OR activated_at IS NOT NULL),
    CONSTRAINT chk_ml_models_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- One active model per name: the one that scores.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_models_active
    ON maintenance.ml_models(name)
    WHERE status = 'active';

-- GET /ml-models: newest first.
CREATE INDEX IF NOT EXISTS idx_ml_models_first_seen
    ON maintenance.ml_models(first_seen_at DESC, id DESC);

CREATE OR REPLACE TRIGGER trg_ml_models_updated_at
    BEFORE UPDATE ON maintenance.ml_models
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

-- Nothing has stored a prediction yet (the nightly scoring is FMS-55), so every
-- existing row, if any, would have to name a registered model already.
DO $$ BEGIN
    ALTER TABLE maintenance.maintenance_predictions
        ADD CONSTRAINT fk_predictions_ml_model FOREIGN KEY (model_name, model_version)
        REFERENCES maintenance.ml_models(name, version) ON DELETE RESTRICT ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_predictions_model
    ON maintenance.maintenance_predictions(model_name, model_version);

INSERT INTO auth.permissions (code, description) VALUES
    ('ml-model:activate', 'Allow a registered predictive-maintenance model to score')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name = 'admin' AND p.code = 'ml-model:activate'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'ml-model:activate';
DELETE FROM auth.permissions WHERE code = 'ml-model:activate';

DROP INDEX IF EXISTS maintenance.idx_predictions_model;
ALTER TABLE IF EXISTS maintenance.maintenance_predictions DROP CONSTRAINT IF EXISTS fk_predictions_ml_model;
DROP TABLE IF EXISTS maintenance.ml_models;
DROP TYPE IF EXISTS maintenance.ml_model_status;
