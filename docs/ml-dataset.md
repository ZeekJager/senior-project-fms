# Predictive maintenance: features and training dataset (FMS-52)

Card: FMS-52 (SE-88). Code: `packages/ai-service/`: `feature_spec.json`, `ml/` and `scripts/generate_training_data.py`. Architecture §12.

The model (FMS-53) gives each vehicle a health score: `round((1 - p) * 100)`, where `p` is the probability of an unplanned failure in the next 30 days. This card fixes three things:

- **What the model sees.** Six features, each computed by the core from its own tables.
- **What it learns to predict.** The label, defined on failure records (FMS-125).
- **What it trains on until real history exists.** A seeded synthetic dataset of 12,000 rows.

## One spec, three readers

`packages/ai-service/feature_spec.json` is the only definition of the inputs and the label. Each feature lists its name, type, unit, range, rounding, time window, source tables, formula, and the value to use when the source has no data. Three things read the spec:

| Reader | Uses it to |
|---|---|
| The dataset generator and its checks (this card) | Produce and validate rows in exactly these columns and ranges |
| Training and the prediction service (FMS-53/54) | Take the inputs in this order, and refuse anything else |
| The core's feature extractor in the nightly scoring job (FMS-55) | Compute the same numbers from the database |

`ml.spec.spec_hash()` is the SHA-256 of the features and label: their names, order, types, ranges, windows and formulas. The model registry (FMS-127) stores it with each model. The core refuses a model whose hash differs from the one its extractor implements, so training and scoring cannot drift apart without anyone noticing.

Changing a feature means changing the spec. That changes the hash, so the model has to be retrained and the extractor updated in the same release. Rewording the descriptions does not change the hash.

## The features

Every feature describes one vehicle at a scoring time `t`. Windows end at `t` and never look past it. All six are computable today from tables the core owns.

| Feature | Unit, range | Window | From | Formula |
|---|---|---|---|---|
| `mileage_km` | km, 0 to 15,000 | 30 days | `trip.trips` | Sum of `actual_distance_km` of completed trips with `actual_end` in `[t - 30 d, t)` |
| `engine_hours` | h, 0 to 720 | 30 days | `trip.trips` | Sum of `actual_duration_seconds / 3600` of the same trips. These are driving hours, until the engine-hour meter readings of FMS-126 replace them |
| `days_since_last_service` | days, 0 to 730 | none | `maintenance.maintenance_records`, `fleet.vehicles` | Days since the `completed_at` of the last completed `preventive` or `inspection` record before `t`. If there is none, days since the vehicle's `created_at`. Capped at 730 |
| `num_fault_reports` | count, 0 to 50 | 90 days | `fleet.dvir_reports`, `alert.incident_reports` | DVIRs with `issues_found = true`, plus `breakdown` and `tyre` incidents, in `[t - 90 d, t)` |
| `fuel_variance_pct` | %, -50 to 100 | 30 days | `fuel.fuel_logs`, `trip.trips`, `fleet.vehicles` | `(actual / expected - 1) * 100`. `actual` is the fuel logged in the window (ml) divided by `mileage_km`; `expected` is `fuel_efficiency_ml_per_km`. It is 0 for electric vehicles, when `mileage_km` is under 100, or when no fuel was logged |
| `age_years` | years, 0 to 40 | none | `fleet.vehicles` | `(t - 1 January of model_year) / 365.25`. Uses `created_at` when `model_year` is null |

`vehicle_id` and `as_of` (which is `t`) identify a row. They are never inputs to the model.

## The label

`failure_within_30_days` is 1 when the vehicle has a failure record (`maintenance.failure_events`, FMS-125) with `unplanned = true` and `occurred_at` in `[t, t + 30 d)`. Otherwise it is 0.

A failure found at planned work is not a positive. The model predicts breakdowns, not service findings. `failure_component` names the component of the first such failure, from the FMS-125 list, or `none`. FMS-53 may use it to say which part is at risk.

The label looks only at the 30 days after `t`, and the features only at time before `t`. A row therefore never sees its own outcome.

## The synthetic dataset

```
cd packages/ai-service
python scripts/generate_training_data.py            # data/training_data.csv (seed 42), in about a second
python scripts/generate_training_data.py --seed 7 --out /tmp/other.csv
```

The script generates 500 vehicles, each scored on the first day of 24 consecutive months from October 2024, which gives 12,000 rows in the spec's columns. It checks them, writes `data/training_data.csv` and prints the spec hash. If a check fails, it writes nothing and exits 1.

The file is generated, never committed: `packages/ai-service/data/` is in `.gitignore`. The same seed gives the same bytes on every run: one seeded generator (NumPy PCG64) drawn in a fixed order, fixed rounding, and `\n` line endings whatever the platform.

### How the rows are made

The rows come from a small simulation, not from rules on the features. A label that is a formula of its own inputs teaches a model nothing it could use on real vehicles.

- **Fixed traits per vehicle:** age (0.5 to 14 years), how hard it is driven (about 3,500 km a month, log-normal), average speed, how often it is serviced (every 45 to 160 days), its own fuel bias, and a hidden frailty the dataset never shows.
- **Each month:**
  - The vehicle drives. About 3% of months it barely moves, as when it sits in the workshop.
  - Its service clock runs, and resets once the clock passes its interval.
  - Faults are reported, more often when it is overdue, old or frail.
  - Fuel use drifts up when service is overdue and when the vehicle is frail.
- **Whether it breaks down** is drawn with a probability that rises with the same causes. Overdue service and reported faults matter most, and most of all together. Hard use of an old vehicle adds risk, rising fuel use is an early sign, and the hidden frailty adds to all of it. A breakdown is repaired, which clears its fault history.

### What the data gives the model

| Check | Value (seed 42) |
|---|---|
| Rows; nulls | 12,000; none |
| Positive rate | 19.1% (the card asks for 15 to 25%) |
| Over 90 days since service and 3 or more faults | 82% fail |
| Serviced within 30 days, no faults | 7% fail |
| Random Forest on vehicles it has not seen (80/20 split by vehicle, balanced class weights) | ROC-AUC ≈ 0.76, F1 ≈ 0.47 at a 0.5 threshold |
| The FMS-53 examples, other inputs at the median | 100 days and 5 faults: health 12; 10 days and 0 faults: health 93 |

The model ranks risk well, but does not predict every failure. That is the point: real failures are noisy, and the hidden frailty stands for everything the core does not record.

A dataset strong enough for F1 ≥ 0.70 would need failures almost fully determined by the six features (AUC ≈ 0.94). That is a model relearning the generator's formula. It would look worse, not better, once real failure records arrive.

FMS-53 is therefore to be judged on ROC-AUC on held-out vehicles plus the two example vehicles, with F1 reported. The split must group rows by `vehicle_id`: a row-level split puts the same vehicle in training and test, and flatters the result.

### Quality checks

`ml.checks.problems(df)` lists everything wrong with a dataset; an empty list means it is fit to train on. The generator runs it before writing, and FMS-53 should run it before training. It checks:

- the columns and their order;
- the row count;
- that there are no nulls;
- that every feature is within its range, with its rounding and type;
- that the label is 0 or 1, with a positive rate of 15 to 25%;
- that components come from the list, and are `none` exactly on negatives;
- that each vehicle has one row per month, with consecutive months.

## Tests and CI

`pytest` in `packages/ai-service` (job `ai-service-ci`) covers:

- the row count, columns, nulls and positive rate;
- the same bytes on rerun, and different data for another seed;
- the signal: the two groups above, and labels that are not a rule on the inputs;
- the zero fuel rule for idle months;
- the component mix;
- a Random Forest reaching an AUC of 0.70 to 0.85 on unseen vehicles, with the FMS-53 examples scoring as specified;
- every quality check;
- the spec itself: the six inputs FMS-54 takes, a source and formula for each, the label defined on failure records, the component list, and the hash.

CI also generates the dataset twice and compares the files.

Python 3.12 is used in Docker and CI. The pins are `pandas` 2.3.3, `numpy` 2.3.4 and `scikit-learn` 1.7.2, with `pytest` 8.4.2 for development.
