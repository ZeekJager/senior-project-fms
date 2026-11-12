"""
The trip risk model (FMS-155): for each label, late and safety_event, gradient-boosted trees on the spec's inputs, their
probabilities calibrated (isotonic) so that "18% chance of running late" means about one such trip in five or six runs
late. Graded on drivers it has not seen, against the rules the console uses without it; it is used only when it beats
them (docs/ml-trip-risk.md).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from ml.trip_risk.spec import LABELS, feature_names

BOOSTING = {
    "max_iter": 200,
    "learning_rate": 0.05,
    "max_leaf_nodes": 15,
    "min_samples_leaf": 40,
    "l2_regularization": 1.0,
    "early_stopping": False,
    "random_state": 0,
}
# One driver in five is held out, and the calibration folds split the rest the same way: no driver on both sides.
FOLDS = 5
SPLIT_SEED = 0

# The rules (the console without a model): the driver's own rate over the last 90 days, from this many trips; with fewer,
# the training rows' rate. FMS-154's fit replaces them as the baseline once it is on the console.
RULES_MIN_TRIPS = 3
RULES = {"late": "driver_late_share_90d", "safety_event": "driver_safety_share_90d"}
# The model is used only when, for both labels, its ROC-AUC on unseen drivers is at least this much above the rules',
# and its Brier score (calibration) no worse.
MIN_AUC_GAIN = 0.01
# The per-depot report: a depot is graded when its held-out rows number at least this, with both outcomes.
DEPOT_MIN_ROWS = 30


def _folds(df: pd.DataFrame, label: str, seed: int = SPLIT_SEED) -> list[tuple[np.ndarray, np.ndarray]]:
    folds = StratifiedGroupKFold(FOLDS, shuffle=True, random_state=seed)
    return list(folds.split(df[feature_names()], df[label], df["driver_id"]))


def split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(train, test): one driver in five held out, stratified on lateness."""
    train, test = _folds(df, "late")[0]
    return df.iloc[train].reset_index(drop=True), df.iloc[test].reset_index(drop=True)


def fit(train: pd.DataFrame) -> dict[str, CalibratedClassifierCV]:
    """One calibrated model per label, keyed by label."""
    models = {}
    for label in LABELS:
        model = CalibratedClassifierCV(
            HistGradientBoostingClassifier(**BOOSTING), method="isotonic", cv=_folds(train, label), ensemble=False
        )
        models[label] = model.fit(train[feature_names()], train[label])
    return models


def probabilities(models: dict[str, Any], X: pd.DataFrame) -> dict[str, np.ndarray]:
    return {label: models[label].predict_proba(X[feature_names()])[:, 1] for label in LABELS}


def rules(df: pd.DataFrame, base_rates: dict[str, float]) -> dict[str, np.ndarray]:
    """The rules' chance for each row: the driver's own 90-day rate, or the base rate for a driver with too few trips."""
    enough = df["driver_trips_90d"].to_numpy() >= RULES_MIN_TRIPS
    return {label: np.where(enough, df[RULES[label]].to_numpy(dtype=float), base_rates[label]) for label in LABELS}


def _grade(y: np.ndarray, p: np.ndarray) -> dict[str, float | None]:
    both = len(np.unique(y)) == 2
    return {
        "roc_auc": round(float(roc_auc_score(y, p)), 4) if both else None,
        "brier": round(float(brier_score_loss(y, p)), 4),
    }


def evaluate(models: dict[str, Any], test: pd.DataFrame, train: pd.DataFrame) -> dict[str, Any]:
    """Everything FMS-155 reports, on the held-out drivers: each label's model and rules, overall and per depot, and the decision."""
    base = {label: float(train[label].mean()) for label in LABELS}
    p, r = probabilities(models, test), rules(test, base)
    out: dict[str, Any] = {"test": {"rows": len(test), "drivers": int(test["driver_id"].nunique())}}
    for label in LABELS:
        y = test[label].to_numpy()
        model_grade, rules_grade = _grade(y, p[label]), _grade(y, r[label])
        depots = []
        for depot, rows in test.groupby("depot_id", sort=True):
            idx = rows.index.to_numpy()
            yd = y[idx]
            if len(idx) < DEPOT_MIN_ROWS or len(np.unique(yd)) < 2:
                depots.append({"depot_id": str(depot), "rows": len(idx), "graded": False})
                continue
            depots.append({
                "depot_id": str(depot), "rows": len(idx), "graded": True, "positive_rate": round(float(yd.mean()), 4),
                "model": _grade(yd, p[label][idx]), "rules": _grade(yd, r[label][idx]),
            })
        out[label] = {
            "positive_rate": round(float(y.mean()), 4),
            "mean_probability": round(float(p[label].mean()), 4),
            "model": model_grade,
            "rules": rules_grade,
            "by_depot": depots,
        }
    out["decision"] = decide(out)
    return out


def decide(metrics: dict[str, Any]) -> dict[str, Any]:
    """Whether the model beats the rules on both labels, and why not when it does not."""
    why = []
    for label in LABELS:
        m, r = metrics[label]["model"], metrics[label]["rules"]
        if m["roc_auc"] is None or r["roc_auc"] is None:
            why.append(f"{label}: the held-out drivers have only one outcome, so nothing can be compared")
            continue
        if m["roc_auc"] < r["roc_auc"] + MIN_AUC_GAIN:
            why.append(f"{label}: ROC-AUC {m['roc_auc']:.3f}, the rules' {r['roc_auc']:.3f}; needs at least {MIN_AUC_GAIN} more")
        if m["brier"] > r["brier"]:
            why.append(f"{label}: Brier {m['brier']:.4f}, worse calibrated than the rules' {r['brier']:.4f}")
    return {"beats_rules": not why, "why": why, "min_auc_gain": MIN_AUC_GAIN}


def importances(models: dict[str, Any], test: pd.DataFrame) -> pd.DataFrame:
    """Per input, how much each label's ROC-AUC on the held-out drivers drops when it is shuffled. Most important first."""
    out = pd.DataFrame({"feature": feature_names()})
    for label in LABELS:
        drop = permutation_importance(
            models[label], test[feature_names()], test[label], scoring="roc_auc", n_repeats=3, random_state=0, n_jobs=1
        )
        out[f"{label}_auc_drop_when_shuffled"] = np.round(drop.importances_mean, 4)
    key = [f"{label}_auc_drop_when_shuffled" for label in LABELS]
    out["total"] = out[key].sum(axis=1)
    return out.sort_values(["total", "feature"], ascending=[False, True], kind="mergesort").drop(columns="total").reset_index(drop=True)
