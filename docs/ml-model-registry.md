# Predictive maintenance: the model registry (FMS-127)

Card: FMS-127 (SE-171). Code:

- `packages/backend/src/modules/maintenance/application/ml-model.service.ts`;
- `domain/ml-model.ts`: statuses, reasons, the canonical feature spec hash;
- `infrastructure/ml-model.repository.ts`, `ml-service.client.ts`, `feature-spec.ts`;
- `api/ml-model.routes.ts`;
- `scripts/ml-model.ts` (`npm run ml:model`);
- migration 039.

Architecture: §12 (track model metadata and version), §23 (predictive maintenance).

A prediction stores a `model_version`. The registry says what that version is: its inputs, the feature definitions they were computed by, its metrics and its training data. It also stops a model trained on one definition of the inputs from being fed another (training/serving skew).

## What is recorded

`maintenance.ml_models` holds one row per model version, written the first time the scoring job sees the ML service serve it. The row comes from the service's `GET /model` (FMS-54, [ml-service.md](ml-service.md)), which reads the model's `metadata.json` and `metrics.json` (FMS-53, [ml-model.md](ml-model.md)):

| Column | From |
|---|---|
| `name`, `version` | `name`, `model_version` (unique together) |
| `algorithm`, `trained_at` | the same |
| `features` | the inputs, in the order the model takes them |
| `feature_spec_version`, `feature_spec_hash` | the feature spec it was trained on |
| `metrics` | `roc_auc`, `brier`, `at_alert_threshold` (precision, recall, F1 below the alert line), `riskiest_tenth_fail_share` |
| `training_data` | file and its SHA-256, rows, vehicles, dates, positive rate, split |
| `artefact_sha256` | the SHA-256 of `model.joblib` |
| `first_seen_at` | when the scoring job registered it |

A row is never edited, except its status. Registration writes one audit row; so does each status change.

## Status

| Status | Means |
|---|---|
| `registered` | Seen; not allowed to score |
| `active` | The model that scores. At most one per name |
| `retired` | Replaced by another active model |

- **Activation is explicit.** A new version never scores on its own: an administrator (`ml-model:activate`) activates it after reviewing its metrics, with `npm run ml:model` or `POST /ml-models/{id}/activate`. The model that was active is retired in the same transaction. Until then the scoring job scores nothing and administrators see an alert, so the first model of a new deployment needs one activation.
- **A rollback** is activating a retired model again. The ML service must also serve it again (`ML_MODEL_VERSION`, [ml-service.md](ml-service.md)), or scoring stays blocked.
- **A model trained on other inputs** cannot be activated: `409 CONFLICT_INVALID_STATE_TRANSITION`, reason `feature_spec_mismatch`. It is still recorded, so what was deployed can be traced.

## The feature spec hash

`packages/ai-service/feature_spec.json` is the one definition of the model's inputs. The Python service trains and validates from it. The core's feature extractor (FMS-55) implements it.

- **The hash** is the SHA-256 of the spec's `features` and `target`, written as canonical JSON: keys sorted, no spaces, everything outside printable ASCII escaped. In Python that is `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=True)` (`ml/spec.py`). Node writes the same bytes (`canonicalJson` in `domain/ml-model.ts`).
- **A number** in the spec must be an integer or a plain decimal (`0.5`, not `1e-05`), as Python and JavaScript write those alike. Node refuses any other number rather than hash it differently.
- **The same file** is read by both sides: the backend reads it at `ML_FEATURE_SPEC_PATH`, by default `../ai-service/feature_spec.json` from `packages/backend`. `docker-compose.yml` mounts it read-only at that path for the backend container.
- **Tests check it.** `ml-model.test.ts` checks Node's canonical JSON against Python's output, and the hash of the real spec against `spec_hash()`. A change to the spec changes the hash on both sides: retrain the model, then update the test's value.

## Before scoring

The nightly scoring (FMS-55, [ml-scoring.md](ml-scoring.md)) calls `mlRegistry.checkServing(context)` before it scores anything:

1. `GET /model` on the ML service, with `X-Internal-Token` (`ML_SERVICE_URL`, `ML_SERVICE_TOKEN`).
2. The version is registered if it is new.
3. The served model may score only when all of these hold:
   - its feature spec hash and the registered one are the core's;
   - its artefact checksum is the registered one (a version names one model);
   - it is the active model.
4. Otherwise the answer is `ok: false` with the reason (`feature_spec_mismatch`, `artefact_mismatch`, `not_active`), and nothing is scored.

When scoring is blocked:

- the reason is logged: an error for a mismatch, a warning for a model not yet active;
- `MlScoringBlocked` is published (one per run, model and reason);
- the alert engine raises an `ml_scoring_blocked` alert for administrators: high for a mismatch, medium for a model awaiting activation. A repeat within 24 hours updates the same alert ([alerts.md](alerts.md)).

An ML service that cannot be reached, refuses the token, or answers without the fields above throws `MlServiceError`, and nothing is registered. The service is called through the integration gateway: a timeout on each attempt, retries, and its circuit breaker ([integrations.md](integrations.md#services-of-the-stack)).

## Predictions

`maintenance.maintenance_predictions (model_name, model_version)` is a foreign key to the registry. A prediction naming a version the registry does not hold cannot be stored, so every score is traceable to its model. The nightly scoring stores each one with the model `checkServing` allowed.

## Activating a model

There is no screen for the registry yet. An administrator uses the backend's script, in the container (`make dev`) or from `packages/backend`:

```
docker exec fms_backend npm run ml:model -- list
docker exec fms_backend npm run ml:model -- activate pm-2026.10 --by admin@example.com
```

- `list` shows each version, its status, whether its features match the core's, its ROC-AUC, and when it was first seen and activated. `--status` filters.
- `activate <version> --by <email>` does what `POST /ml-models/{id}/activate` does. The audit log records it as that administrator, from a script. The account must be active and hold `ml-model:activate`. `--name` picks another model name (default `predictive-maintenance`).
- A rollback: activate the retired version, and have the ML service serve it again (`ML_MODEL_VERSION`).

## API

- `GET /ml-models` (`prediction:read`): newest first, `status` to filter, paged. `features_match` says whether the model's hash is the core's. `feedback` is how the version's high-risk predictions fared when technicians inspected the vehicles (FMS-128): counts of each outcome and `precision`, the confirmed share of the ones judged, overall and by month ([ml-scoring.md](ml-scoring.md#feedback-from-technicians-fms-128)).
- `GET /ml-models/{id}` (`prediction:read`).
- `POST /ml-models/{id}/activate` (`ml-model:activate`, administrators).

Contract: [api-contract.md §10.2](api-contract.md#102-predictive-maintenance). Nothing registers a model through the API.

## Tests

`test/integration/ml-models.test.ts` runs against a stub of the ML service's `GET /model`. It covers:

- registration with every field, once, audited;
- reading the registry with `prediction:read` (and `403` for a driver);
- scoring blocked until activation, with an alert for administrators;
- activation, retirement, rollback, and `403` without `ml-model:activate`;
- `npm run ml:model`: the list, activation as the named administrator (audited), and refusals for anyone else, an unknown version or a model on other inputs;
- a feature spec mismatch: scoring refused, logged, alerted once, and activation refused;
- an artefact served under a registered version;
- a wrong token, a bad answer, or no service;
- a prediction naming an unregistered version refused by the database.
