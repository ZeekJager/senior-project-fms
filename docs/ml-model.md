# Predictive maintenance: the model (FMS-53)

Card: FMS-53 (SE-89). Code: `packages/ai-service/ml/model.py`, `ml/artefact.py`, `scripts/train.py` and `scripts/evaluate.py`. Architecture §12.

The model gives each vehicle a health score from 0 to 100: `round((1 - p) * 100)`, where `p` is the probability of an unplanned failure in the next 30 days. It takes the 19 inputs of `feature_spec.json` and learns from the training dataset ([ml-dataset.md](ml-dataset.md)).

## Training and grading

```
cd packages/ai-service
python scripts/generate_training_data.py                  # data/training_data.csv
python scripts/train.py                                   # models/pm-<year.month>/, about 25 s
python scripts/train.py --version pm-2026.10.2            # another model the same month
python scripts/evaluate.py models/pm-2026.10              # grades it again
```

`train.py` does the following, in order:

1. Runs the dataset's quality checks.
2. Holds out one vehicle in five (2,424 rows of 101 vehicles). The split groups rows by `vehicle_id`, so no vehicle is on both sides, and is stratified, so each side has the fleet's share of failures.
3. Trains on the other 9,576 rows.
4. Grades the model on the held-out vehicles.

If the data fails a check or the model misses a criterion below, `train.py` writes nothing and exits 1. `evaluate.py` re-runs the grading from the saved folder. It refuses to grade when:

- the folder fails its checksum;
- the data is not the file the model was trained on;
- the held-out vehicles differ from the ones training recorded.

It exits 1 if the metrics do not match those recorded at training, or the model misses a criterion.

**Acceptance criteria** (`ml.model.gates`):

| Criterion | Mark |
|---|---|
| ROC-AUC on vehicles the model has not seen | at least 0.75 |
| High-risk example: 100 days since service, 5 fault reports | scores below 30 |
| Healthy example: 10 days since service, no faults | scores above 85 |
| Model file | under 50 MB |

The two examples are typical vehicles. Every other input is at its median in the training rows. The oil's age follows the service date, because every service changes the oil.

Precision, recall and F1 are recorded but not gated ([ml-dataset.md](ml-dataset.md#what-the-data-gives-the-model) explains why F1 ≥ 0.70 is out of reach). They are taken at a health score below 75, which is where the core raises a risk event (FMS-55).

### What it scores

Five different splits of the vehicles:

| | Seed 0 (shipped) | Five splits |
|---|---|---|
| ROC-AUC | 0.831 | 0.79 to 0.83 |
| Riskiest tenth that fail | 73% | 57 to 73% |
| Safest half that fail | 5% | 5 to 7% |
| Below 75: share of the fleet | 25% | 20 to 25% |
| Below 75: precision (fail within 30 days) | 0.50 | 0.46 to 0.50 |
| Below 75: recall (failures caught) | 0.66 | 0.56 to 0.66 |
| Below 75: F1 | 0.57 | 0.51 to 0.57 |
| Examples (below 30, above 85) | 19 and 98 | 4 to 19 and 97 to 100 |
| Model file | 6.5 MB | |

About 18% of vehicles fail in a given month. So a vehicle below 75 is two and a half to three times as likely as average to fail. Between half and two thirds of failures were below 75 beforehand.

The inputs that move the score most, measured by how much ROC-AUC drops when each is shuffled:

1. fault reports;
2. distance since the belts were changed;
3. distance since the oil was changed;
4. days since service;
5. distance since the brake pads were changed.

`feature_importance.csv` lists all 19.

## Why calibrated

The model is a Random Forest of 300 trees (`min_samples_leaf` 5, seed 0). Its probabilities are calibrated with isotonic regression, fitted on the forest's predictions for training vehicles held out of it fold by fold (`CalibratedClassifierCV`, `ensemble=False`).

The health score is read as a probability, and the core alerts below 75, a 25% chance of failure. The alternatives fail that reading. On the same held-out vehicles:

| | Average predicted risk (18.9% fail) | Fleet below 75 | High-risk example |
|---|---|---|---|
| Forest with balanced class weights | 27% | 43% | 27 |
| Plain forest | 19% | 25% | 32: fails its criterion |
| **Plain forest, calibrated (shipped)** | **18%** | **25%** | **19** |

- **Balanced class weights** (as the dataset card measured) rank just as well but inflate every probability. Nearly half the fleet would raise a risk event every night.
- **A plain forest** is honest on average, but its probabilities crowd towards the middle, so the riskiest vehicles look safer than they are.
- **Calibration** keeps the ranking and maps the scores back to how often vehicles really fail.

## The model's folder

`models/<model_version>/`, where the version is `pm-<year>.<month>` (the contract's `model_version`, `pm-2026.10`), or `pm-2026.10.2` for a second model in the same month. A version names one model: `train.py` refuses a folder that exists. `packages/ai-service/models/` is in `.gitignore`. Models are rebuilt from the seeded data, never committed.

| File | Holds |
|---|---|
| `model.joblib` | The calibrated forest (joblib, compressed) |
| `metadata.json` | See the list below |
| `metrics.json` | Everything above, as measured on the held-out vehicles, with the examples' full inputs |
| `feature_importance.csv` | Per input: the drop in ROC-AUC when shuffled, and the forest's impurity importance. Most important first |

`metadata.json` holds what the model registry (FMS-127) records:

- `name`, `model_version` and `trained_at`;
- the algorithm and hyperparameters;
- `features` (in order), `target` and the health score formula;
- `feature_spec_version` and `feature_spec_hash`;
- `training_data`: the file's SHA-256, its rows, vehicles and date range, the split, and the held-out vehicles;
- the library versions;
- `artefact_sha256`, the checksum of `model.joblib`.

**Opening a model.** Use only `ml.artefact.load`. A joblib file is a pickle, and opening it runs code, so `load` first checks the file against its checksum. It also refuses a model whose `feature_spec_hash` or features differ from this code's `feature_spec.json`. Load only folders built by `train.py` from this repository.

## Tests and CI

`tests/test_model.py` trains once on the generated dataset and checks:

- the split: by vehicle, one in five held out, with the fleet's share of failures;
- the criteria: ROC-AUC, the examples, the file size;
- that the riskiest tenth fail far more often than the fleet;
- that the probabilities are honest: the average predicted risk is the share that fails, and below 75 flags 10 to 35% of the fleet;
- the folder's files, version, inputs, spec hash, training data and checksum;
- the feature importance file;
- that `evaluate.py` reproduces the recorded metrics;
- that a tampered model, a model for other inputs, and other data are refused;
- that a version is never reused, a malformed version or bad data is refused, and a model that misses a criterion is not written.

The `ai-service-ci` job also trains a model on the generated dataset and grades it with `evaluate.py`. `joblib` is pinned at 1.6.0.
