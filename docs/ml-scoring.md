# Predictive maintenance: the nightly scoring (FMS-55)

Card: FMS-55 (SE-91). Code:

- `packages/backend/src/modules/maintenance/application/scoring.service.ts`: the run;
- `domain/scoring.ts`: the 19 formulas, caps, risk levels and when a risk event is raised;
- `infrastructure/scoring.repository.ts`, `ml-service.client.ts`;
- the reads in other modules: `fleet/infrastructure/scoring.queries.ts`, `trip/infrastructure/trip-usage.queries.ts`, and one query each in fuel and alert;
- migration 040.

Architecture §23 (predictive maintenance), Scenario C, §28.3 (timeouts, retries, circuit breaking).

Every night the job gives each vehicle a health score, so screens show the risk without calling the model on every page load. The screens are in [vehicle-health.md](vehicle-health.md).

## A run

The job `maintenance-scoring` runs daily at 02:00 (Addis Ababa), after `engine-hours` (01:00) has read yesterday's engine hours ([jobs.md](jobs.md)).

1. **The model.** `mlRegistry.checkServing` asks the ML service which model it serves (`GET /model`) and registers it if it is new ([ml-model-registry.md](ml-model-registry.md)). Scoring goes ahead only with the active model, trained on the core's feature spec.
2. **The vehicles.** Every vehicle in service: `is_active`, status `active`, `inactive` or `maintenance`. Retired vehicles are not scored.
3. **The inputs.** The 19 inputs of `feature_spec.json`, for every vehicle at once, one query per source.
4. **The ML service.** Batches of 100 to `POST /internal/ml/predict-maintenance/batch` (api-contract §10.3).
5. **Each batch** is stored in one transaction:
   - the prediction;
   - the vehicle's health score;
   - a risk event where the score fell below 75.

The run's result goes into the job history. It holds counts: `vehicles`, `scored`, `already_scored`, `skipped`, `risk_events`, `batches_failed`, `model_version`, `blocked`, `duration_ms`.

## The scoring time

Every input is computed as of `t`, the start of the run's local day: 00:00 Addis Ababa. Its windows end at `t`, as in training ([ml-dataset.md](ml-dataset.md)). A run retried later the same day therefore computes the same inputs.

The request's `as_of` is `t` with its offset: `2026-10-25T00:00:00+03:00`.

## The inputs

The formulas are `FEATURE_FORMULAS` in `domain/scoring.ts`, one per input, as the spec states them. Each module reads its own tables (CONVENTIONS.md, Modules rule 3):

| Input | Read from | Through |
|---|---|---|
| `mileage_km`, and driving hours for `engine_hours` | completed trips with `actual_end` in `[t - 30 d, t)` | `completedTripUsage` (trip) |
| `engine_hours` | the engine-hour meter (FMS-126): its trusted reading at `t` less its reading at `t - 30 d` | `scoringRefs.engineHours` (fleet) |
| `days_since_last_service` | the last completed `preventive` or `inspection` record before `t` | maintenance |
| `num_fault_reports` | DVIRs with `issues_found`, plus `breakdown` and `tyre` incidents, in `[t - 90 d, t)` | `scoringRefs.faultyDvirs` (fleet), `incidentLookup.countsByVehicle` (alert) |
| `fuel_variance_pct` | fuel logged in `[t - 30 d, t)`, against `fuel_efficiency_ml_per_km` | `fuelUsage.loggedMl` (fuel) |
| `age_years` and every "never changed" value | `model_year`, `created_at`, `odometer_km` | `scoringRefs.vehicles` (fleet) |
| The part history (13 inputs) | each item's last change before `t`; kilometres of the completed trips since | maintenance, `completedDistanceAfter` (trip) |

- **Engine hours** are the meter's increase over the window once the meter was read at or before `t - 30 d` and again after it. Until then, and for vehicles without an ignition-reporting device, they are driving hours. This follows the spec's formula.
- **Caps and rounding.** Each input is capped to the spec's range and rounded to its decimals: whole days, one decimal for kilometres. The ML service refuses anything outside the spec rather than clipping it, so the extractor clips.
- **The extractor's spec.** The extractor implements spec version 2. Its hash is pinned in `EXTRACTOR_SPEC_HASH`. If `feature_spec.json` changes and the extractor is not updated with it, the run fails before scoring anything, and the job history gives the reason. This is a deployment error, not an outage. The unit test also checks that the formulas cover exactly the spec's inputs, in order.

## Calling the ML service

The service is reached through the integration gateway (FMS-85, [integrations.md](integrations.md#services-of-the-stack)), with `integrationGateway.internalClient`:

- **Configuration.** `ML_SERVICE_URL` and `ML_SERVICE_TOKEN` (`X-Internal-Token`); `X-Request-Id` is the run's correlation id.
- **Each attempt** has 10 s.
- **Retries.** A prediction changes nothing on the service, so a failed batch is retried like a GET: twice, with jitter, on a timeout, a network error or a 5xx. Each attempt counts towards the breaker.
- **The breaker** belongs to the ML service on each API instance. Once at least 5 calls are in its 60-second window and more than half failed, it opens. While it is open, calls fail at once without reaching the service. After 30 s one trial call is let through.
- **The answer is checked.** It must hold one prediction per vehicle, in order, each within its ranges, and come from the model the registry allowed. If the service restarted with another model between the check and the batch, the batch is not stored.

## What is stored

| Where | What |
|---|---|
| `maintenance.maintenance_predictions` | One row per vehicle and night: `model_name`, `model_version`, `prediction_type` (`failure_within_30_days`), `risk_score` (the failure probability), `health_score`, `risk_level`, `factors` (up to 3 inputs that raise the risk most), `prediction_horizon_days` (30), `feature_snapshot` (the 19 inputs as sent), `as_of` (`t`). The vehicle's previous active prediction becomes `superseded` |
| `fleet.vehicles` | `health_score` and `health_score_updated_at` (the run's start), the snapshot screens read |

- Each write is audited as the system, with the run's correlation id.
- One prediction per vehicle, type, scoring time and model (`ux_predictions_scoring`, migration 040). A run retried the same day skips the vehicles that model already scored, and counts them as `already_scored`.
- A prediction names a registered model (FMS-127): `(model_name, model_version)` references `maintenance.ml_models`.
- `GET /vehicles/{id}` is cached for up to 60 s, so it may show the old score for that long after the run.

## Risk events

A score below 75 (`RISK_ALERT_BELOW`, CFG-3) raises `MaintenanceRiskDetected` when either holds:

- the vehicle's previous score was 75 or more, or it had none;
- its risk level rose, from medium to high.

A vehicle that stays below 75 at the same level raises no new event. Its alert stays open until someone resolves it.

| Score | Previous | Event |
|---|---|---|
| 60 | none, or 80 | yes (`medium`) |
| 80 | anything | no |
| 60 | 70 | no |
| 35 | 60 | yes (`high`) |

- **Payload:** `prediction_id`, `vehicle_id`, `risk_level`, `failure_probability`, `health_score`, `previous_health_score`, `factors`, `component` (null: the model predicts no failure category), `model_name`, `model_version`, `as_of`.
- **Event id.** Each event has a fixed id from the scoring time, vehicle and model.
- **The alert.** The engine raises a `maintenance_risk` alert in the vehicle's depot for technicians and depot admins. Its severity is the risk level. Its message reads, for example: "Health score 60, a 40% chance of a breakdown within 30 days, mostly from days since last service, km since oil change. Schedule an inspection." ([alerts.md](alerts.md))

## When it does not score

The run still finishes in every case below, except the last.

| What | The run | Seen as |
|---|---|---|
| The ML service cannot be reached, or `GET /model` fails | Skips every vehicle | `blocked: ml_unavailable`; an error is logged (`maintenance.scoring_skipped`) |
| The served model is not active, was trained on other inputs, or its artefact differs | Skips every vehicle | `blocked: not_active` (or the other reason); the registry's `ml_scoring_blocked` alert for administrators |
| A batch fails after its retries | Skips that batch's vehicles; the others are scored | `batches_failed`; an error per batch (`maintenance.scoring_batch_failed`) |
| The breaker opens during the run | The remaining batches fail at once without calling the service | the same |
| A batch comes back from another model | Not stored | the same |
| `feature_spec.json` is not the spec the extractor implements | Fails | `job.failed`; the scheduler retries it, up to 5 attempts that day |

Vehicles that were skipped keep their last score. The health score screen (FMS-56) shows a score older than 25 hours as stale.

## Speed

The card's budget is 200 vehicles in under 90 seconds. The integration test scores 200 vehicles, each with a trip and a fill-up, in about 0.6 s against a stub service. The ML service itself scores a batch of 100 in well under 0.1 s ([ml-service.md](ml-service.md)).

## On the seeded fleet

The budget seed (200 vehicles, [seed-data.md](seed-data.md#service-history)), scored by `pm-2026.10` through the real service:

| | Vehicles | Average health score | Below 75 | High risk |
|---|---|---|---|---|
| Combustion | 184 | 86 | 21 (11%) | 0 |
| Electric | 16 | 47 | 14 | 6 |

The model scores electric vehicles low. The spec has no notion of an engine that needs no oil, so an electric vehicle's oil, fuel filter, belt, gearbox oil and clutch fluid count as never changed, and the synthetic fleet it was trained on has no electric vehicles. Scoring them properly needs a change to the spec (FMS-52).

## Tests

`src/modules/maintenance/domain/scoring.test.ts` covers the extractor:

- it implements the spec's inputs, in order, and its hash;
- every formula, including the missing-data rules and the engine-hour meter;
- caps and rounding;
- risk levels, and when an event is raised.

`test/integration/ml-scoring.test.ts` runs against a stub ML service (`GET /model` and the batch endpoint). It covers:

- every vehicle in service scored, a retired one not; the prediction, the health score and the audit rows;
- each input computed from real trips, fuel logs, DVIRs, incidents, repairs with parts and meter readings, including rows outside their windows;
- a score of 60 raising the event and the alert, and 80 not; no new event while a score stays below, one when it worsens; each night superseding the last;
- a retried run scoring only what it had not;
- the ML service down: logged, skipped, finished;
- predictions failing: the breaker opening and the remaining batches failing fast;
- a model not yet active, and a batch from another model;
- 200 vehicles in under 90 s.
