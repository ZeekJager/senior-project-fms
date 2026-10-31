"""
The predictive maintenance model (FMS-53): a Random Forest on the feature
spec's inputs, its probabilities calibrated so that a health score means what
it says, graded on vehicles it has not seen (docs/ml-dataset.md).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import brier_score_loss, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from ml.spec import feature_names, target_name

MODEL_NAME = "predictive-maintenance"
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


def health_score(p) -> np.ndarray:
    """0 to 100, higher is healthier: round((1 - p) * 100), p the probability of a failure in 30 days."""
    return np.round((1.0 - np.asarray(p, dtype=float)) * 100.0).astype(int)


def _folds(df: pd.DataFrame, seed: int) -> list[tuple[np.ndarray, np.ndarray]]:
    # By vehicle, so no vehicle is on both sides; stratified, so each side has the fleet's share of failures.
    folds = StratifiedGroupKFold(FOLDS, shuffle=True, random_state=seed)
    return list(folds.split(df[feature_names()], df[target_name()], df["vehicle_id"]))


def split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The 80/20 split by vehicle: (train, test)."""
    train, test = _folds(df, SPLIT_SEED)[0]
    return df.iloc[train].reset_index(drop=True), df.iloc[test].reset_index(drop=True)


def fit(train: pd.DataFrame) -> CalibratedClassifierCV:
    """
    The forest, trained on every training row, and an isotonic calibration fitted
    on its predictions for vehicles held out of it, fold by fold. A forest's own
    probabilities crowd towards the middle; calibrated, a 20% risk fails about
    one time in five, which is what the core's alert threshold assumes.
    """
    model = CalibratedClassifierCV(
        RandomForestClassifier(**FOREST), method="isotonic", cv=_folds(train, SPLIT_SEED), ensemble=False
    )
    return model.fit(train[feature_names()], train[target_name()])


def probability(model, X: pd.DataFrame) -> np.ndarray:
    """The probability of an unplanned failure in the next 30 days, for each row."""
    return model.predict_proba(X[feature_names()])[:, 1]


def forest(model: CalibratedClassifierCV) -> RandomForestClassifier:
    return model.calibrated_classifiers_[0].estimator


def example_inputs(reference: pd.DataFrame) -> dict[str, dict[str, float]]:
    """
    The board's examples as full inputs: every input at its median in the
    reference rows (the training set), then the example's service age and
    faults. The oil is changed at every service, so its age follows.
    """
    median = reference[feature_names()].median()
    out = {}
    for name, (days, faults) in EXAMPLES.items():
        row = median.copy()
        row["days_since_last_service"], row["num_fault_reports"] = days, faults
        row["days_since_oil_change"] = days
        row["km_since_oil_change"] = round(days * median["mileage_km"] / 30.0, 1)
        out[name] = {k: float(v) for k, v in row.items()}
    return out


def evaluate(model, test: pd.DataFrame, reference: pd.DataFrame) -> dict[str, Any]:
    """Everything FMS-53 reports about a model, measured on the held-out vehicles."""
    y = test[target_name()].to_numpy()
    p = probability(model, test)
    flagged = health_score(p) < ALERT_BELOW
    riskiest = np.argsort(-p, kind="stable")
    tenth, half = len(p) // 10, len(p) // 2
    examples = example_inputs(reference)
    scores = health_score(probability(model, pd.DataFrame(list(examples.values()))))
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


def importances(model, test: pd.DataFrame) -> pd.DataFrame:
    """
    Per input: the forest's impurity importance, and how much ROC-AUC on the
    held-out vehicles drops when that input is shuffled (the one to explain;
    impurity favours inputs with many distinct values). Most important first.
    """
    drop = permutation_importance(
        model, test[feature_names()], test[target_name()], scoring="roc_auc", n_repeats=5, random_state=0, n_jobs=-1
    )
    out = pd.DataFrame({
        "feature": feature_names(),
        "auc_drop_when_shuffled": np.round(drop.importances_mean, 4),
        "impurity_importance": np.round(forest(model).feature_importances_, 4),
    })
    return out.sort_values(["auc_drop_when_shuffled", "feature"], ascending=[False, True], kind="mergesort").reset_index(drop=True)
