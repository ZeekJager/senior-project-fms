# Predictive maintenance: features and training dataset (FMS-52)

Card: FMS-52 (SE-88). Code:
- `packages/ai-service/`: `feature_spec.json`, `ml/` and `scripts/generate_training_data.py`;
- the part history in the backend: `inventory_parts.service_item` (migration 037) and `GET /vehicles/{vehicle_id}/service-items`.

Architecture §12.

The model (FMS-53) gives each vehicle a health score: `round((1 - p) * 100)`, where `p` is the probability of an unplanned failure in the next 30 days. This card fixes three things:

- **What the model sees.** 19 inputs, each computed by the core from its own tables.
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

## The inputs

Every input describes one vehicle at a scoring time `t`. Windows end at `t` and never look past it.

### Use, faults, fuel and age

The board's six original inputs.

| Feature | Unit, range | Window | From | Formula |
|---|---|---|---|---|
| `mileage_km` | km, 0 to 15,000 | 30 days | `trip.trips` | Sum of `actual_distance_km` of completed trips with `actual_end` in `[t - 30 d, t)` |
| `engine_hours` | h, 0 to 720 | 30 days | `trip.trips` | Sum of `actual_duration_seconds / 3600` of the same trips. These are driving hours, until the engine-hour meter readings of FMS-126 replace them |
| `days_since_last_service` | days, 0 to 730 | none | `maintenance.maintenance_records`, `fleet.vehicles` | Days since the `completed_at` of the last completed `preventive` or `inspection` record before `t`. If there is none, days since the vehicle's `created_at`. Capped at 730 |
| `num_fault_reports` | count, 0 to 50 | 90 days | `fleet.dvir_reports`, `alert.incident_reports` | DVIRs with `issues_found = true`, plus `breakdown` and `tyre` incidents, in `[t - 90 d, t)` |
| `fuel_variance_pct` | %, -50 to 100 | 30 days | `fuel.fuel_logs`, `trip.trips`, `fleet.vehicles` | `(actual / expected - 1) * 100`. `actual` is the fuel logged in the window (ml) divided by `mileage_km`; `expected` is `fuel_efficiency_ml_per_km`. It is 0 for electric vehicles, when `mileage_km` is under 100, or when no fuel was logged |
| `age_years` | years, 0 to 40 | none | `fleet.vehicles` | `(t - 1 January of model_year) / 365.25`. Uses `created_at` when `model_year` is null |

### Part history

These say how long since each wearing part and fluid was last changed. Some parts wear with distance, some with time, and some with both, so each gets the measure that fits it.

| Feature | Item | Typical interval (trucks) | Protects |
|---|---|---|---|
| `days_since_oil_change`, `km_since_oil_change` | `engine_oil` (oil and its filter) | 12,000 km or 6 months | engine |
| `km_since_air_filter_change` | `air_filter` | 25,000 km | engine, fuel system |
| `km_since_fuel_filter_change` | `fuel_filter` | 30,000 km | fuel system |
| `days_since_coolant_change` | `coolant` (radiator fluid) | 2 years | cooling |
| `km_since_brake_pad_change` | `brake_pads` | 45,000 km | brakes |
| `days_since_brake_fluid_change` | `brake_fluid` | 2 years | brakes |
| `days_since_clutch_fluid_change` | `clutch_fluid` | 2 years | transmission |
| `km_since_tyre_change`, `days_since_tyre_change` | `tyres` | 80,000 km or about 5.5 years | tyres |
| `days_since_battery_change` | `battery` | 4 years | electrical |
| `km_since_gearbox_oil_change` | `gearbox_oil` | 80,000 km | transmission |
| `km_since_belt_change` | `belts` (drive belts) | 80,000 km | engine, electrical |

- **The last change** of an item is the `completed_at` of the vehicle's latest completed repair, before `t`, that used a stocked part whose `service_item` is that item. A repair that used oil part `OIL-15W40-5` (`service_item = engine_oil`) is an oil change.
- **Days since the change:** whole days from that change to `t`, capped at 3,650.
- **Kilometres since the change:** the `actual_distance_km` of completed trips after the change and before `t`, capped at 500,000. This is the same source as `mileage_km`, so a missing odometer on the repair does not matter.
- **Never changed in the system:** days count from 1 January of `model_year` (`created_at` when that is null), and kilometres are the vehicle's whole `odometer_km`. This is pessimistic on purpose. A vehicle whose coolant history is unknown should be checked, not trusted as fresh.
- **Tyres** are tracked per vehicle, not per wheel: any tyre change resets them.

### Where the backend gets the part history (Option A)

No new form is needed. Technicians already list the parts a repair used (FMS-22). Each stocked part now says which item it renews: `maintenance.inventory_parts.service_item`, migration 037. It is `null` for parts that renew none, such as a wiper blade or a shock absorber.

| What | Where |
|---|---|
| Set what a part renews | `service_item` on `POST /inventory` and `PUT /inventory/{id}`; anything outside the list is `400`. The seed sets it for its oil, filters, brake pads, tyres, battery, belt and coolant |
| See when a vehicle's items were last changed | `GET /vehicles/{vehicle_id}/service-items` (`maintenance:read`, depot scope): all 11 items with `last_changed_at`, the repair, its odometer and the part number; `null`s when never |
| Read it in the nightly scoring (FMS-55) | `maintenanceRefs.lastServiceItems(db, vehicleId, before)`, the same query as of a time |

This reads only workshop repairs that used stocked parts. A change done elsewhere, or with a part not in stock, is invisible to it. A later card, preventive service programs (FMS-129), can add explicit "done on" records.

Stock parts for brake fluid, clutch fluid and gearbox oil are not in the seed yet. Until a depot creates one, those items count as never changed.

`vehicle_id` and `as_of` (which is `t`) identify a row. They are never inputs to the model.

## The label

`failure_within_30_days` is 1 when the vehicle has a failure record (`maintenance.failure_events`, FMS-125) with `unplanned = true` and `occurred_at` in `[t, t + 30 d)`. Otherwise it is 0.

A failure found at planned work is not a positive. The model predicts breakdowns, not service findings. `failure_component` names the component of the first such failure, from the FMS-125 list, or `none`. FMS-53 may use it to say which part is at risk.

The label looks only at the 30 days after `t`, and the inputs only at time before `t`. A row therefore never sees its own outcome.

## The synthetic dataset

```
cd packages/ai-service
python scripts/generate_training_data.py            # data/training_data.csv (seed 42), in about a second
python scripts/generate_training_data.py --seed 7 --out /tmp/other.csv
```

The script generates 500 vehicles, each scored on the first day of 24 consecutive months from October 2024, which gives 12,000 rows in the spec's columns. It checks them, writes `data/training_data.csv` and prints the spec hash. If a check fails, it writes nothing and exits 1.

The file is generated, never committed: `packages/ai-service/data/` is in `.gitignore`. The same seed gives the same bytes on every run, checked on Windows and on Linux: one seeded generator (NumPy PCG64) drawn in a fixed order, fixed rounding, and `\n` line endings.

### How the rows are made

The rows come from a small simulation, not from rules on the inputs. A label that is a formula of its own inputs teaches a model nothing it could use on real vehicles.

- **Fixed traits per vehicle:**
  - age (0.5 to 14 years);
  - how hard it is driven (about 3,500 km a month, log-normal) and its average speed;
  - how often it is serviced (every 45 to 160 days);
  - how late its owner changes each item relative to its interval. Most run a little late; some keep up the oil and let the coolant go; a few neglect everything;
  - its own fuel bias;
  - a hidden frailty the dataset never shows.
- **Each month:**
  - The vehicle drives. About 3% of months it barely moves, as when it sits in the workshop.
  - Every item ages by distance and time.
  - A service, when due (or when the oil is), changes the oil, and the air and fuel filters once they are past 60% of their interval. Everything changed in a workshop visit shares its day, so the oil is never older than the last service. Other items are changed when their owner gets round to them.
  - Faults are reported more often when something is overdue, old or frail.
  - Fuel use drifts up with overdue service, clogged filters and frailty.
- **Whether it breaks down** is drawn with a probability that rises most with overdue parts. Overdue service and reported faults come next, most of all together. Hard use of an old vehicle and rising fuel use add their own risk, and the hidden frailty adds to all of it.
- **Which part fails** is most often one whose protecting items are overdue: worn pads lead to brakes, old coolant to cooling. Otherwise wear parts follow distance, and old vehicles fail in the engine and cooling.
- **A breakdown is repaired:** the failed component's items are renewed, and the fault history clears.
- **A year of warm-up** is simulated before the first recorded month. Otherwise every vehicle would start with its parts at random ages, and the first month would be a wave of breakdowns.

### What the data gives the model

These are measured with a Random Forest on vehicles it has not seen: an 80/20 split by vehicle, balanced class weights, five different splits. "Before" is the first version of this card, with the six board inputs only.

| | Before (6 inputs) | Now (19 inputs) |
|---|---|---|
| Positive rate | 19.1% | 18.2% (the card asks for 15 to 25%) |
| Ranking, ROC-AUC | 0.76 | **0.79 to 0.83** |
| Riskiest 10% that fail | 60% | **61 to 71%** |
| Safest half that fail | 8% | **5 to 7%** |
| Names the failed component (guessing the most common gives 22%) | 17% | **30 to 34%** |
| F1 at a 0.5 threshold | 0.47 | 0.48 to 0.55 |
| Best F1 of a perfect model (it knows the true probabilities, frailty included) | 0.54 | 0.61 |
| FMS-53 examples, below 30 and above 85 | 14 and 92 | **14 to 28 and 93 to 97** |

The strongest inputs are now the oil's distance since change, the belts' distance, days since service, and the brake pad and gearbox oil distances.

The FMS-53 examples are typical vehicles: every other input at its median, with the oil's age following the service date, because the oil is changed at every service.
- The risky example is 100 days since service with 5 faults; its oil is 100 days old.
- The healthy example is 10 days since service with no faults.

**Why F1 ≥ 0.70 is out of reach.** Even a perfect model, one that knows each vehicle's hidden frailty, reaches only F1 0.61 here, because breakdowns are partly chance. Reaching 0.70 would need failures almost fully determined by the inputs. That is a model relearning the generator's formula, and it would look worse once real failure records arrive.

FMS-53 is therefore judged as follows ([ml-model.md](ml-model.md)):
- ROC-AUC of at least 0.75 on vehicles it has not seen; the split groups rows by `vehicle_id`, because a row-level split puts the same vehicle in training and test and flatters the result. The mark sits below the 0.79 to 0.83 measured so that an unlucky split does not fail a sound model;
- the two example vehicles;
- F1, precision and recall reported, but not gated.

The forest measured above weights the classes equally, which ranks well but inflates its probabilities. The model FMS-53 ships calibrates them instead ([ml-model.md](ml-model.md#why-calibrated)).

### Quality checks

`ml.checks.problems(df)` lists everything wrong with a dataset; an empty list means it is fit to train on. The generator runs it before writing, and `scripts/train.py` (FMS-53) runs it before training. It checks:

- the columns and their order;
- the row count;
- that there are no nulls;
- that every input is within its range, with its rounding and type;
- that the label is 0 or 1, with a positive rate of 15 to 25%;
- that components come from the list, and are `none` exactly on negatives;
- that each vehicle has one row per month, with consecutive months.

## Tests and CI

`pytest` in `packages/ai-service` (job `ai-service-ci`) covers:

- the row count, columns, nulls and positive rate;
- the same bytes on rerun, and different data for another seed;
- the signal: overdue service with faults versus fresh service without, labels that are not a rule on the inputs, and parts that age and are renewed;
- overdue brake pads, coolant and battery failing their own component more than twice as often as on-time ones;
- the zero fuel rule for idle months;
- the component mix;
- a Random Forest reaching an AUC of 0.72 to 0.88 on unseen vehicles, with the examples scoring as specified;
- every quality check;
- the spec itself: the board's six inputs then the part history, a source, formula and service item for each, the label defined on failure records, the component list, and the hash.

CI also generates the dataset twice and compares the files.

The backend's part history is covered by `test/integration/service-items.test.ts`.

Python 3.12 is used in Docker and CI. The pins are `pandas` 2.3.3, `numpy` 2.3.4 and `scikit-learn` 1.7.2, with `pytest` 8.4.2 for development.
