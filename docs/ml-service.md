# Predictive maintenance: the service (FMS-54)

Card: FMS-54 (SE-90). Code:

- `packages/ai-service/app.py`: the FastAPI app;
- `ml/serving.py`: predictions, risk levels and factors;
- `Dockerfile.dev`.

Architecture: ADR-02 (a separate predictive maintenance service), §12, §25 (internal network).

The model (FMS-53, [ml-model.md](ml-model.md)) runs behind an internal HTTP API, so the Node.js core never runs Python, and the model can change without a core release. The core's nightly scoring (FMS-55) calls it. The contract is [api-contract.md §10.3](api-contract.md#103-internal-ml-service-contract).

## Endpoints

| Endpoint | Token | Does |
|---|---|---|
| `GET /health` | No | `{status: "ok", model_version, load_seconds}`. The service only starts with a model, so a running service has one |
| `GET /model` | Yes | The model serving now: version, inputs, feature spec version and hash, artefact checksum, training data, metrics. The registry (FMS-127) records it, and the core refuses to score when its own spec hash differs |
| `POST /internal/ml/predict-maintenance` | Yes | One vehicle |
| `POST /internal/ml/predict-maintenance/batch` | Yes | 1 to 500 vehicles, answered in the same order |

A prediction carries:

- `failure_probability`: the chance of an unplanned failure in the next 30 days;
- `health_score`: `round((1 - p) * 100)`;
- `risk_level`;
- `prediction_horizon_days`: 30;
- `model_version`;
- `factors`.

**Risk levels** come from the health score, so they agree with the core's alert line (a risk event below 75):

| Level | Health score | Failure chance |
|---|---|---|
| `low` | 75 and above | 25% or less |
| `medium` | 41 to 74 | |
| `high` | 40 and below | 60% or more |

**Factors** say why this vehicle is at risk, for the health score screen (FMS-56).

- Each input in turn is put back to the training rows' median (`feature_medians` in the model's metadata).
- The inputs whose substitution lowers the probability by at least 0.01 are factors, largest drop first, at most 3.
- A healthy vehicle has none.
- One `predict_proba` call scores every vehicle and every substitution: 20 rows per vehicle.
- A model trained before `feature_medians` was recorded serves without factors.

## Inputs

The request's `features` must be exactly the inputs of `feature_spec.json`. The service builds its validation from that file:

- every input is required;
- each must be within the spec's `min` and `max`;
- an `int` input must be an integer;
- an unknown input is refused.

A request that breaks any of these is `422 VALIDATION_FAILED`, naming each field (`features.mileage_km`, `items.3.features.age_years`) with a reason: `required`, `out_of_range`, `not_allowed`, `too_few`, `too_many`, `invalid_json` or `invalid`. Errors use the core's envelope (`error.code`, `error.message`, `error.details`, `meta.request_id`).

The service refuses rather than clips. The core's extractor caps every input as the spec says, so a value outside its range is a bug to see, not to hide.

## Security

- **Token.** `ML_SERVICE_TOKEN` (generated into `.env` by `make env`) is sent as `X-Internal-Token`. It is compared in constant time. Missing or wrong is `401 AUTH_TOKEN_INVALID`. The service will not start with a token shorter than 32 characters, so the `.env.example` placeholder cannot be used by mistake.
- **Internal network.** `docker-compose.yml` publishes no port for `ai-service`. Only containers on the stack's network reach it, at `http://ai-service:5000`, like Redis.
- **No interactive docs.** FastAPI's `/docs`, `/redoc` and `/openapi.json` are off; the contract is in api-contract.md.
- **The model file.** It is a pickle. It is opened only through `ml.artefact.load`, which checks its SHA-256 against its metadata, and its feature spec hash against this code's, before unpickling. The image runs as a non-root user (uid 10001).
- **No personal data.** The service gets a vehicle id and numbers, and never touches PostgreSQL.

## Running it

```
cd packages/ai-service
python scripts/generate_training_data.py && python scripts/train.py
ML_SERVICE_TOKEN=<32+ characters> uvicorn app:create_app --factory --port 5000
```

- `ML_MODELS_DIR` is the folder of model versions (default `./models`).
- `ML_MODEL_VERSION` picks one; by default the newest version there serves (`pm-2026.10.2` after `pm-2026.10`).
- The model is loaded once, at start-up. A missing model, a checksum or spec mismatch, or a short token stops the service from starting, with the reason.

**In Docker** (`make dev`), the image trains its model when it is built: the seeded dataset, then `train.py`, into `/opt/models`, outside the source volume. A build trains a model graded like any other: `train.py` writes nothing when the model misses a criterion, and the build fails. The container answers its health check within about 3 s of starting.

## Speed

Measured in the container on a laptop:

| Request | Time |
|---|---|
| One vehicle over HTTP | about 25 ms (median of 20; the card's budget is 200 ms) |
| A batch of 200 vehicles | 0.06 s |
| A batch of 500 vehicles | 0.11 s |
| Model load at start-up | 0.2 s |

The forest predicts on one thread: small batches are faster that way.

## Tests

`tests/test_service.py` (pytest, with FastAPI's test client on `httpx2`) uses the model the model tests train. It covers:

- `/health` without a token;
- a prediction's fields and score, and agreement with the model itself;
- the board's examples through the API: high risk below 30, healthy above 85 with no factors;
- factors;
- a batch in order;
- `422` for a missing, out-of-range, mistyped or unknown input, a missing vehicle or time, an empty or oversized batch, and bad JSON;
- `401` without a token or with a wrong one, on every protected endpoint;
- `/model`;
- the request id passed through;
- one vehicle in under 200 ms (median of 20);
- refusing to start without a usable token or model, or with a tampered model file;
- which version serves.

Pins: `fastapi` 0.143.0, `starlette` 1.7.0, `pydantic` 2.14.0, `uvicorn` 0.54.0; `httpx2` 2.13.1 for tests. Flask is gone.
