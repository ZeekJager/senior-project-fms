"""
Predictions as the service (FMS-54) returns them: the probability of an
unplanned failure in the next 30 days, the health score, the risk level and
the inputs behind the risk, from a model folder loaded once (ml.artefact).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ml import artefact
from ml.model import forest, health_score

PREDICTION_HORIZON_DAYS = 30

# Risk levels by health score, so they agree with the core's alert line (a score below 75, FMS-55):
# low at 75 and above (a failure chance of 25% or less), high at 40 and below (60% or more).
LOW_FROM = 75
HIGH_UP_TO = 40

# An input counts as a factor when putting it back to its typical value lowers the risk by at least this.
FACTOR_MIN_DROP = 0.01
MAX_FACTORS = 3


def risk_level(score: int) -> str:
    if score >= LOW_FROM:
        return "low"
    if score <= HIGH_UP_TO:
        return "high"
    return "medium"


class Predictor:
    """A loaded model and what its predictions need from its metadata."""

    def __init__(self, model, metadata: dict[str, Any]):
        self.model = model
        self.metadata = metadata
        self.features: list[str] = metadata["features"]
        self.version: str = metadata["model_version"]
        medians = metadata.get("feature_medians") or {}
        self.medians = pd.Series({name: float(medians[name]) for name in self.features}) if len(medians) == len(self.features) else None
        # Small batches are faster on one thread than spread over many.
        forest(model).n_jobs = 1

    @classmethod
    def load(cls, folder: Path) -> "Predictor":
        """Through ml.artefact.load: the checksum and the feature spec are checked before anything is unpickled."""
        model, metadata = artefact.load(folder)
        return cls(model, metadata)

    def predict(self, rows: list[dict[str, float]]) -> list[dict[str, Any]]:
        """One prediction per row of inputs, in order."""
        X = pd.DataFrame(rows, columns=self.features).astype(float)
        p, factors = self._probabilities_and_factors(X)
        scores = health_score(p)
        return [
            {
                "failure_probability": round(float(prob), 4),
                "health_score": int(score),
                "risk_level": risk_level(int(score)),
                "prediction_horizon_days": PREDICTION_HORIZON_DAYS,
                "model_version": self.version,
                "factors": f,
            }
            for prob, score, f in zip(p, scores, factors)
        ]

    def _probabilities_and_factors(self, X: pd.DataFrame) -> tuple[np.ndarray, list[list[str]]]:
        """
        The probabilities, and for each row the inputs that raise its risk most: those that, put back one
        at a time to the training rows' median, lower the probability by at least FACTOR_MIN_DROP, largest
        drop first, at most MAX_FACTORS. One predict call covers every row and every substitution.
        """
        n, k = len(X), len(self.features)
        if self.medians is None:
            return self.model.predict_proba(X)[:, 1], [[] for _ in range(n)]
        variants = [X]
        for name in self.features:
            v = X.copy()
            v[name] = self.medians[name]
            variants.append(v)
        p_all = self.model.predict_proba(pd.concat(variants, ignore_index=True))[:, 1].reshape(k + 1, n)
        p, drops = p_all[0], p_all[0] - p_all[1:]
        factors = []
        for row in range(n):
            order = np.argsort(-drops[:, row], kind="stable")
            factors.append([self.features[i] for i in order[:MAX_FACTORS] if drops[i, row] >= FACTOR_MIN_DROP])
        return p, factors

    def describe(self, metrics: dict[str, Any]) -> dict[str, Any]:
        """GET /model: what the registry (FMS-127) records about the model serving now."""
        m = self.metadata
        data = {k: v for k, v in m["training_data"].items() if k != "test_vehicles"}
        return {
            "name": m["name"],
            "model_version": m["model_version"],
            "trained_at": m["trained_at"],
            "algorithm": m["algorithm"],
            "features": m["features"],
            "feature_spec_version": m["feature_spec_version"],
            "feature_spec_hash": m["feature_spec_hash"],
            "artefact_sha256": m["artefact_sha256"],
            "training_data": data,
            "metrics": {
                "roc_auc": metrics["roc_auc"],
                "brier": metrics["brier"],
                "at_alert_threshold": metrics["at_alert_threshold"],
                "riskiest_tenth_fail_share": metrics["riskiest_tenth_fail_share"],
            },
            "health_score": m["health_score"],
            "risk_levels": {"low": f"health score {LOW_FROM} and above", "medium": f"{HIGH_UP_TO + 1} to {LOW_FROM - 1}", "high": f"{HIGH_UP_TO} and below"},
            "prediction_horizon_days": PREDICTION_HORIZON_DAYS,
        }
