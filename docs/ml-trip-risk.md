# Predicted trip risk (FMS-155)

Card: FMS-155 (SE-199). Extends FR-20 with prediction.

When a dispatcher chooses a trip on the console (S-07), each driver free for it shows two predictions:

- their chance of the trip **running late**, with the two inputs that raise it most;
- their chance of a **safety event**.

> **18% chance of running late:** 10.5 h driven in the last day, 6 h at night
> 4% chance of a safety event

The predictions are learnt from the fleet's completed trips. A model makes them only once it has beaten hand-written rules on drivers it has not seen. They are advice for one trip:

- they never block an assignment;
- they never reorder or rank the drivers;
- drivers never see them.

## Code

| Where | What |
|---|---|
| `packages/ai-service/trip_risk_spec.json` | The inputs and labels: the one definition, shared by both sides |
| `ml/trip_risk/features.py` | The inputs, in Python, for the generated data |
| `ml/trip_risk/dataset.py` | The data checks, the minimum, and the generated dataset |
| `ml/trip_risk/model.py` | Training, the rules baseline, and the decision |
| `ml/trip_risk/serving.py` | The model served |
| `scripts/generate_trip_risk_data.py`, `train_trip_risk.py`, `evaluate_trip_risk.py` | The scripts |
| `app.py` | `GET /models/trip-risk` and `POST /internal/ml/predict-trip-risk` |
| `packages/backend/migrations/073_trip_risk_facts.sql` | `analytics.trip_risk_facts` |
| `analytics/domain/trip-risk.ts` | The inputs, in TypeScript: the core's extractor |
| `analytics/application/trip-risk.service.ts`, `infrastructure/trip-risk.repository.ts` | The status, the drivers' chances and the dataset |
| `maintenance` | The registry (`checkTripRisk`, activation) and the ML client |
| `fleet/application/dispatch.service.ts` | The board |
| `scripts/trip-risk-dataset.ts` | `npm run ml:trip-risk-dataset` |
| `packages/frontend/src/pages/Dispatch/Candidates.tsx`, `tripRisk.ts` | The console |

## What it learns from

**A row** is one driver on one completed trip, with what was known at `t`, the trip's scheduled start.

**The rows** are every completed trip with:

- a driver;
- a scheduled start and end;
- an actual start and end;
- a measured distance (`actual_distance_source` set, [FMS-145](trip-distance.md)).

A trip with a distance entered before trips were measured, as the seed's are, is never trained on. So a model can never be learnt from the seed alone.

**The labels:**

| Label | 1 when |
|---|---|
| `late` | The trip ended more than its depot's `trip_delay_minutes` (else the fleet's, 15) after its scheduled end: the delay alert's margin ([FMS-147](eta.md#the-trip-delay-alert-fms-147)) |
| `safety_event` | A speeding flag was raised on the trip, or its driver had an accident (incident type `accident`) between its actual start and end |

**The inputs:** 22, all known before the trip starts. `trip_risk_spec.json` gives each one's formula, range, rounding and value when missing.

| Group | Inputs |
|---|---|
| The driver's record, over the last 90 days | `driver_trips_90d`, `driver_late_share_90d`, `driver_safety_share_90d` |
| Their record on jobs of this load | `driver_same_load_trips_90d`, `driver_same_load_late_share_90d` |
| The job ([FMS-153](job-load.md)) | `job_load_points`, `planned_distance_km`, `planned_duration_h`, `stops`, `night_hours`, `cargo_share`, `cargo_hazardous`, `cargo_fragile`, `cargo_refrigerated`, `cargo_passengers` |
| When it runs (Addis Ababa) | `start_hour`, `weekday` |
| How rested the driver is | `hours_since_last_trip` (0 while on a trip, 336 with none earlier), `hours_driven_24h`, `hours_driven_7d` |
| The route's record | `route_trips_90d`, `route_late_share_90d` |

**No protected attributes.** No name, age, gender, home address, phone, email or photo is an input, nor anything standing in for one. Both sides' tests check the spec for them.

**One formula on both sides.**

- **The core** computes the inputs in `tripRiskFeatures` (TypeScript), from `analytics.trip_risk_facts` on the read replica, for training and for the console alike.
- **The ML service** computes the same in `features.py` (Python), for its generated data.
- **The shared fixture** `packages/ai-service/tests/fixtures/trip_risk_features.json` holds cases both test suites must reproduce to the decimal. Rounding is half-up on both sides (`Math.round`), never Python's half-to-even.
- **The spec's hash** is computed as the maintenance spec's ([ml-model-registry.md](ml-model-registry.md#the-feature-spec-hash)). A model trained on other inputs cannot be activated.

## Not enough trips yet

A model is trained only on **at least 2,000 trips across 20 drivers** (the spec's `minimum`). `train_trip_risk.py` refuses less, writes nothing, and says how far there is to go.

Until there is enough, and no model is active, the console says so above the drivers:

> Not enough trips yet for a trip risk prediction: 412 of 2,000 completed trips, 9 of 20 drivers.

## A demonstration while there is too little

The fleet may not reach the minimum before the project ends. So the pipeline ships with a **demonstration**: a model trained on generated trips (`scripts/generate_trip_risk_data.py`).

**The generated data:**

- 60 drivers of 4 depots over 210 days, about 11,900 trips;
- simulated trip by trip in time order, so each trip's inputs come from the history before it, as the core computes them;
- the outcomes follow a known rule: each driver's own habits, fatigue (more than 10 hours driven in a day, or under 8 hours of rest), the night, the job's load and the route raise both risks.

So a model has something real to learn, and the driver's past rates alone, which are the rules, miss the fatigue and the job.

**Labelled everywhere:**

| Where | Label |
|---|---|
| Every generated row | `source: generated` |
| The model's metadata | `demonstration: true` |
| The registry | `demonstration` |
| `npm run ml:model -- list` | `demonstration` |
| The console | "Trip risk is a demonstration: the model learnt from generated trips, not this fleet's." |

The two sources are never mixed in one dataset.

The images train the demonstration when they are built, beside the maintenance model. It is not used until an administrator activates it.

## Beating the rules

The rules are what the console has without a model: the driver's own late and safety-event rates over the last 90 days. With fewer than 3 trips, the training rows' rate stands in.

FMS-154's fit replaces them as the baseline once it is on the console (see [Not covered](#not-covered)).

**Training:**

- **The split:** one driver in five is held out (`StratifiedGroupKFold` by `driver_id`), so no driver is on both sides.
- **The models:** for each label, gradient-boosted trees (`HistGradientBoostingClassifier`) with isotonic calibration, fitted on held-out folds of the training drivers.
- **Calibration** makes "18%" mean about one such trip in five or six runs late.

**Grading,** on the held-out drivers, for each label, the model's and the rules':

- ROC-AUC;
- Brier score (calibration);
- both again per depot (one with 30 or more rows and both outcomes).

**The decision:** the model is used only if, for **both labels**:

- its ROC-AUC is at least **0.01** above the rules';
- its Brier score is no worse.

`metrics.decision` records `beats_rules` and, when false, why. A model that does not beat the rules is still written and registered, so the registry shows why the console kept the rules. It can never be activated (`409`, reason `does_not_beat_rules`).

**The demonstration's grades** (seed 155, 2,174 trips of 12 unseen drivers):

| | Model ROC-AUC | Rules ROC-AUC | Model Brier | Rules Brier |
|---|---|---|---|---|
| Late (15.4% of trips) | 0.757 | 0.684 | 0.112 | 0.122 |
| Safety event (8.1%) | 0.693 | 0.644 | 0.072 | 0.074 |

It beats the rules in every depot, on both labels.

**The strongest inputs**, by how much ROC-AUC drops when each is shuffled:

1. the driver's past safety rate;
2. hours driven in the last day;
3. the driver's past late rate;
4. hours of rest;
5. the job's load.

`feature_importance.csv` lists all 22.

These figures are the generated data's rule played back. The fleet's own model must earn its place on its own trips.

## The model's folder

`models/tr-<year>.<month>/` (`tr-2026.11`, or `tr-2026.11.2` for another the same month), beside the maintenance model's `pm-*`. The files are as the maintenance model's ([ml-model.md](ml-model.md#the-models-folder)):

| File | Holds |
|---|---|
| `model.joblib` | `{late, safety_event}`, the two calibrated models |
| `metadata.json` | `demonstration`, `labels`, `feature_medians`, `training_data` (with `source` and the held-out drivers), and the spec's hash |
| `metrics.json` | Each label's grades overall and per depot, and `decision` |
| `feature_importance.csv` | Each input's AUC drop per label |

`evaluate_trip_risk.py` grades a folder again. It exits 1 when:

- the folder fails its checksum;
- the data or the held-out drivers are not what training recorded;
- the metrics differ from those recorded.

## Serving and the registry

**The ML service** serves the model when its folder is in `ML_MODELS_DIR`: the newest `tr-*`, or `ML_TRIP_RISK_MODEL_VERSION`.

- **Optional:** without one the service starts, and its trip risk endpoints answer `404`.
- **Checked:** a folder that fails its checksum or spec stops the service, as the maintenance model's does.

| Endpoint | Does |
|---|---|
| `GET /models/trip-risk` | What the registry records |
| `POST /internal/ml/predict-trip-risk` | 1 to 200 drivers on one trip. For each: `late_probability`, `safety_event_probability`, and `factors.late` and `factors.safety_event`, at most two `{feature, value}` each |

The inputs are checked against the spec: each required, in range, and nothing else ([ml-service.md](ml-service.md)).

**Factors** are found as the maintenance model's are. Each input in turn is put back to its median in the training rows. Those whose substitution lowers the chance by at least 0.01 are factors, largest drop first.

**The registry** (`maintenance.ml_models`, name `trip-risk`, [ml-model-registry.md](ml-model-registry.md#the-trip-risk-model-fms-155)):

- **Registration:** a model is registered the first time the board, or `npm run ml:model -- list`, sees it served.
- **Use:** only once an administrator activates it, and only while its spec hash and artefact are the registered ones.

## On the console

**The request:** `GET /dispatch/availability` with `exclude_trip_id`, the trip being staffed, by a caller with `tracking:read` (dispatchers, fleet managers, administrators), as for the driver score.

**The board's `trip_risk`** says whether the drivers carry chances:

| `status` | When | The console |
|---|---|---|
| `ok` | The active model, served and matching | Each free driver's two chances. A note when it is a demonstration |
| `not_enough_trips` | No usable model, and fewer than 2,000 trips or 20 drivers | "Not enough trips yet…" with the counts |
| `off` | No usable model for another `reason`: `service_off`, `no_model`, `not_active`, `feature_spec_mismatch`, `artefact_mismatch` | "Trip risk prediction is off." |
| `unavailable` | The ML service failed | "Trip risk could not be predicted just now." |

**Each driver's `trip_risk`:**

- **Free drivers:** the model's chances.
- **Drivers blocked for the trip** (a safety rule: licence, account, another trip): never asked about, and `null`.
- **Without `tracking:read`**, or without a trip: no chances, and the board's `trip_risk` is `null`.

**How it is worked out:**

- **The model's status** is cached for a minute, as the board polls.
- **The inputs** are read from the replica, as of the trip's scheduled start.
- **Failure:** the model is asked outside the board's transaction, and a failure leaves the board as it was.

## Training on the fleet's trips

```
npm run ml:trip-risk-dataset -w fms-backend -- --out ../ai-service/data/trip_risk_fleet.csv
cd packages/ai-service
python scripts/train_trip_risk.py --data data/trip_risk_fleet.csv      # refuses below the minimum
python scripts/evaluate_trip_risk.py models/tr-2026.12 --data data/trip_risk_fleet.csv
# deploy the folder to the service's ML_MODELS_DIR, then:
npm run ml:model -w fms-backend -- list
npm run ml:model -w fms-backend -- activate tr-2026.12 --name trip-risk --by admin@example.com
```

**The export** (`source: fleet`) holds:

- public ids, times and numbers, nothing personal;
- one row per eligible trip, with its inputs as of its scheduled start from every trip that had started.

## Tests

**Python** (`tests/test_trip_risk.py`):

- the spec: 22 inputs, each documented, none protected;
- the shared fixture;
- the generated dataset: reproducible, passing its checks, a demonstration;
- the checks finding bad rows, mixed sources and duplicates;
- refusal below the minimum, and of an empty export;
- the demonstration beating the rules, calibrated, graded per depot;
- `evaluate_trip_risk.py` reproducing its metrics and refusing other data;
- a model with outcomes shuffled within each driver: written with `beats_rules: false` and why;
- a version reused or misnamed;
- a tampered model, or one for other inputs;
- a tired driver on a heavy night job riskier than a rested one, with the factors saying why;
- the service:
  - both models served side by side;
  - the inputs checked;
  - the token required;
  - without a trip risk model, `404`.

**Backend:**

- **`test/integration/trip-risk.test.ts`:**
  - the shared fixture through the core's extractor and the trip module's job load;
  - `analytics.trip_risk_facts`: late by the margin, speeding and accidents, measured;
  - the board against a stub service:
    - not enough trips without a model;
    - registered but unused until activated;
    - then each free driver's chances, with the exact inputs sent, and none for a blocked driver;
  - a model that did not beat the rules refused activation;
  - one on other inputs refused;
  - a failing service leaving the board as it was;
  - `ml:model -- list` labelling a demonstration;
  - the dataset export's columns and rows.
- **`fleet/application/dispatch.service.test.ts`:**
  - only with `tracking:read` and a trip;
  - only free drivers;
  - a provider that throws.
- **`maintenance/domain/ml-model.test.ts`:** Node's hash of `trip_risk_spec.json` is Python's.

**Frontend** (`DispatchPage.test.tsx`):

- a driver's chances and factors in words;
- the demonstration note;
- "Not enough trips yet" with the drivers' order unchanged.

**CI:** `ai-service-ci` generates the trips twice and compares them byte for byte, then trains and re-grades the model.

## Not covered

- **FMS-154's fit.** The console's "fit for this trip" (FMS-154) is not built yet. Until it is:
  - the chances show on their own;
  - the rules the model must beat are the driver's own past rates.

  When it lands, the late chance becomes one reason in a driver's fit, and the fit's rules become the baseline.
- **Unknown.** Whether the fleet will have 2,000 measured trips across 20 drivers before the project ends. Until then the console shows the demonstration, labelled as such, once an administrator activates it, or "Not enough trips yet".
