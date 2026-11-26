"""
The predictive maintenance model (FMS-53): a Random Forest on the feature
spec's inputs, its probabilities calibrated so that a health score means what
it says, graded on vehicles it has not seen (docs/ml-dataset.md).

Two kinds share it (FMS-135): the combustion model on feature_spec.json and the
EV model on feature_spec_ev.json, each with its name, spec, examples and
version pattern (KINDS). Every function takes the kind, combustion by default.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import brier_score_loss, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from ml import spec as combustion_spec
from ml.ev import spec as ev_spec

MODEL_NAME = "predictive-maintenance"
EV_MODEL_NAME = "predictive-maintenance-ev"
FOREST = {"n_estimators": 300, "min_samples_leaf": 5, "random_state": 0, "n_jobs": -1}
# One vehicle in five is held out (the 80/20 split), and the calibration folds split the rest the same way.
FOLDS = 5
SPLIT_SEED = 0

# The grading (FMS-53).
MIN_ROC_AUC = 0.75
HIGH_RISK_BELOW = 30
HEALTHY_ABOVE = 85
MAX_ARTEFACT_MB = 50
# The core raises a risk event below this health score (FMS-55); precision and recall are reported there.
ALERT_BELOW = 75

# The board's example vehicles: days since service and fault reports, every other input typical.
EXAMPLES = {"high_risk": (100, 5), "healthy": (10, 0)}

# The EV model's (FMS-135): a worn, hot pack with failed charging and faults, and a new, cool one.
EV_EXAMPLES = {
    "high_risk": {
        "battery_health_pct": 76.0,
        "battery_health_drop_90d": 4.0,
        "high_temp_hours_30d": 220.0,
        "failed_charging_sessions_90d": 6,
        "num_fault_reports": 4,
        "days_since_last_service": 150,
    },
    "healthy": {
        "battery_health_pct": 97.0,
        "battery_health_drop_90d": 0.0,
        "high_temp_hours_30d": 0.0,
        "failed_charging_sessions_90d": 0,
        "num_fault_reports": 0,
        "days_since_last_service": 10,
    },
}


def _combustion_examples(median: pd.Series) -> dict[str, pd.Series]:
    """The board's examples: the service age and faults; the oil is changed at every service, so its age follows."""
    out = {}
    for name, (days, faults) in EXAMPLES.items():
        row = median.copy()
        row["days_since_last_service"], row["num_fault_reports"] = days, faults
        row["days_since_oil_change"] = days
        row["km_since_oil_change"] = round(days * median["mileage_km"] / 30.0, 1)
        out[name] = row
    return out


def _ev_examples(median: pd.Series) -> dict[str, pd.Series]:
    out = {}
    for name, values in EV_EXAMPLES.items():
        row = median.copy()
        for k, v in values.items():
            row[k] = v
        out[name] = row
    return out


@dataclass(frozen=True)
class Kind:
    """One predictive maintenance model: its registry name, its feature spec, its examples and how its versions are named."""

    name: str
    spec: Any  # the spec module: load_spec, feature_names, target_name, spec_hash
    examples: Callable[[pd.Series], dict[str, pd.Series]]
    version: re.Pattern[str]
    prefix: str
    data_file: str
    dataset_script: str

    def feature_names(self) -> list[str]:
        return self.spec.feature_names()

    def target_name(self) -> str:
        return self.spec.target_name()


COMBUSTION = Kind(
    MODEL_NAME, combustion_spec, _combustion_examples, re.compile(r"^pm-[0-9]{4}\.[0-9]{2}(\.[0-9]+)?$"), "pm", "training_data.csv", "scripts/generate_training_data.py"
)
EV = Kind(
    EV_MODEL_NAME, ev_spec, _ev_examples, re.compile(r"^pm-ev-[0-9]{4}\.[0-9]{2}(\.[0-9]+)?$"), "pm-ev", "ev_training_data.csv", "scripts/generate_ev_training_data.py"
)
KINDS = {"combustion": COMBUSTION, "ev": EV}
BY_NAME = {k.name: k for k in KINDS.values()}


def kind_of_folder(folder: Path) -> Kind | None:
    """The kind a model folder's name says it is: pm-ev-2026.11 an EV model, pm-2026.10 a combustion one."""
    return next((k for k in (EV, COMBUSTION) if k.version.match(folder.name)), None)


def health_score(p) -> np.ndarray:
    """0 to 100, higher is healthier: round((1 - p) * 100), p the probability of a failure in 30 days."""
    return np.round((1.0 - np.asarray(p, dtype=float)) * 100.0).astype(int)


def _folds(df: pd.DataFrame, seed: int, kind: Kind = COMBUSTION) -> list[tuple[np.ndarray, np.ndarray]]:
    # By vehicle, so no vehicle is on both sides; stratified, so each side has the fleet's share of failures.
    folds = StratifiedGroupKFold(FOLDS, shuffle=True, random_state=seed)
    return list(folds.split(df[kind.feature_names()], df[kind.target_name()], df["vehicle_id"]))


def split(df: pd.DataFrame, kind: Kind = COMBUSTION) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The 80/20 split by vehicle: (train, test)."""
    train, test = _folds(df, SPLIT_SEED, kind)[0]
    return df.iloc[train].reset_index(drop=True), df.iloc[test].reset_index(drop=True)


def fit(train: pd.DataFrame, kind: Kind = COMBUSTION) -> CalibratedClassifierCV:
    """
    The forest, trained on every training row, and an isotonic calibration fitted
    on its predictions for vehicles held out of it, fold by fold. A forest's own
    probabilities crowd towards the middle; calibrated, a 20% risk fails about
    one time in five, which is what the core's alert threshold assumes.
    """
    model = CalibratedClassifierCV(
        RandomForestClassifier(**FOREST), method="isotonic", cv=_folds(train, SPLIT_SEED, kind), ensemble=False
    )
    return model.fit(train[kind.feature_names()], train[kind.target_name()])


def probability(model, X: pd.DataFrame, kind: Kind = COMBUSTION) -> np.ndarray:
    """The probability of an unplanned failure in the next 30 days, for each row."""
    return model.predict_proba(X[kind.feature_names()])[:, 1]


def forest(model: CalibratedClassifierCV) -> RandomForestClassifier:
    return model.calibrated_classifiers_[0].estimator


def example_inputs(reference: pd.DataFrame, kind: Kind = COMBUSTION) -> dict[str, dict[str, float]]:
    """
    The board's examples as full inputs: every input at its median in the
    reference rows (the training set), then the example's own values (the
    combustion examples' service age and faults; the EV examples' pack).
    """
    median = reference[kind.feature_names()].median()
    return {name: {k: float(v) for k, v in row.items()} for name, row in kind.examples(median).items()}


def evaluate(model, test: pd.DataFrame, reference: pd.DataFrame, kind: Kind = COMBUSTION) -> dict[str, Any]:
    """Everything FMS-53 reports about a model, measured on the held-out vehicles."""
    y = test[kind.target_name()].to_numpy()
    p = probability(model, test, kind)
    flagged = health_score(p) < ALERT_BELOW
    riskiest = np.argsort(-p, kind="stable")
    tenth, half = len(p) // 10, len(p) // 2
    examples = example_inputs(reference, kind)
    scores = health_score(probability(model, pd.DataFrame(list(examples.values())), kind))
    return {
        "roc_auc": round(float(roc_auc_score(y, p)), 4),
        "brier": round(float(brier_score_loss(y, p)), 4),
        "test": {"rows": len(test), "vehicles": int(test["vehicle_id"].nunique()), "positive_rate": round(float(y.mean()), 4)},
        "mean_probability": round(float(p.mean()), 4),
        "at_alert_threshold": {
            "health_score_below": ALERT_BELOW,
            "flagged_share": round(float(flagged.mean()), 4),
            "precision": round(float(precision_score(y, flagged, zero_division=0)), 4),
            "recall": round(float(recall_score(y, flagged)), 4),
            "f1": round(float(f1_score(y, flagged)), 4),
        },
        "riskiest_tenth_fail_share": round(float(y[riskiest[:tenth]].mean()), 4),
        "safest_half_fail_share": round(float(y[riskiest[half:]].mean()), 4),
        "examples": {
            name: {"health_score": int(score), "inputs": inputs} for (name, inputs), score in zip(examples.items(), scores)
        },
    }


def gates(metrics: dict[str, Any], artefact_mb: float | None = None) -> list[str]:
    """Each FMS-53 acceptance criterion the model misses, one line each; empty when it passes."""
    found = []
    if metrics["roc_auc"] < MIN_ROC_AUC:
        found.append(f"ROC-AUC {metrics['roc_auc']:.3f} on unseen vehicles, needs at least {MIN_ROC_AUC}")
    high, healthy = (metrics["examples"][k]["health_score"] for k in ("high_risk", "healthy"))
    if not high < HIGH_RISK_BELOW:
        found.append(f"high-risk example scores {high}, needs below {HIGH_RISK_BELOW}")
    if not healthy > HEALTHY_ABOVE:
        found.append(f"healthy example scores {healthy}, needs above {HEALTHY_ABOVE}")
    if artefact_mb is not None and artefact_mb >= MAX_ARTEFACT_MB:
        found.append(f"model file is {artefact_mb:.1f} MB, needs under {MAX_ARTEFACT_MB}")
    return found


def importances(model, test: pd.DataFrame, kind: Kind = COMBUSTION) -> pd.DataFrame:
    """
    Per input: the forest's impurity importance, and how much ROC-AUC on the
    held-out vehicles drops when that input is shuffled (the one to explain;
    impurity favours inputs with many distinct values). Most important first.
    """
    drop = permutation_importance(
        model, test[kind.feature_names()], test[kind.target_name()], scoring="roc_auc", n_repeats=5, random_state=0, n_jobs=-1
    )
    out = pd.DataFrame({
        "feature": kind.feature_names(),
        "auc_drop_when_shuffled": np.round(drop.importances_mean, 4),
        "impurity_importance": np.round(forest(model).feature_importances_, 4),
    })
    return out.sort_values(["auc_drop_when_shuffled", "feature"], ascending=[False, True], kind="mergesort").reset_index(drop=True)
