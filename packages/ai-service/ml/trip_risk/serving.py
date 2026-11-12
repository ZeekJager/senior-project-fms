"""
Trip risk predictions as the service returns them (FMS-155): each driver's chance of running late and of a safety event
on one trip, and the two inputs that raise each most, from a model folder loaded once.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ml import artefact
from ml.trip_risk.spec import LABELS, feature_names, minimum, spec_hash

# tr-2026.11, or tr-2026.11.2 for another model the same month.
VERSION = re.compile(r"^tr-[0-9]{4}\.[0-9]{2}(\.[0-9]+)?$")
# An input counts as a factor when putting it back to its typical value lowers the chance by at least this.
FACTOR_MIN_DROP = 0.01
# "the two factors that raise it most" (FMS-155).
MAX_FACTORS = 2


def load(folder: Path):
    """(models, metadata), through ml.artefact.load against the trip risk spec."""
    return artefact.load(folder, expected_hash=spec_hash(), expected_features=feature_names())


class TripRiskPredictor:
    def __init__(self, models: dict[str, Any], metadata: dict[str, Any], metrics: dict[str, Any]):
        self.models = models
        self.metadata = metadata
        self.metrics = metrics
        self.features: list[str] = metadata["features"]
        self.version: str = metadata["model_version"]
        self.demonstration: bool = bool(metadata.get("demonstration"))
        medians = metadata["feature_medians"]
        self.medians = pd.Series({name: float(medians[name]) for name in self.features})

    @classmethod
    def load(cls, folder: Path) -> "TripRiskPredictor":
        models, metadata = load(folder)
        _, metrics = artefact.read(folder)
        return cls(models, metadata, metrics)

    def predict(self, rows: list[dict[str, float]]) -> list[dict[str, Any]]:
        """One prediction per row of inputs, in order."""
        X = pd.DataFrame(rows, columns=self.features).astype(float)
        out: list[dict[str, Any]] = [{} for _ in rows]
        for label in LABELS:
            p, factors = self._with_factors(label, X)
            for i, row in enumerate(out):
                row[f"{label}_probability"] = round(float(p[i]), 4)
                row.setdefault("factors", {})[label] = [{"feature": name, "value": float(X.at[i, name])} for name in factors[i]]
        for row in out:
            row["model_version"] = self.version
            row["demonstration"] = self.demonstration
        return out

    def _with_factors(self, label: str, X: pd.DataFrame) -> tuple[np.ndarray, list[list[str]]]:
        """As the maintenance model explains (FMS-54): each input put back to its training median; the largest drops, at most two."""
        n, k = len(X), len(self.features)
        variants = [X]
        for name in self.features:
            v = X.copy()
            v[name] = self.medians[name]
            variants.append(v)
        p_all = self.models[label].predict_proba(pd.concat(variants, ignore_index=True))[:, 1].reshape(k + 1, n)
        p, drops = p_all[0], p_all[0] - p_all[1:]
        factors = []
        for row in range(n):
            order = np.argsort(-drops[:, row], kind="stable")
            factors.append([self.features[i] for i in order[:MAX_FACTORS] if drops[i, row] >= FACTOR_MIN_DROP])
        return p, factors

    def describe(self) -> dict[str, Any]:
        """GET /models/trip-risk: what the registry (FMS-127) records about it."""
        m, metrics = self.metadata, self.metrics
        return {
            "name": m["name"],
            "model_version": m["model_version"],
            "trained_at": m["trained_at"],
            "algorithm": m["algorithm"],
            "features": m["features"],
            "feature_spec_version": m["feature_spec_version"],
            "feature_spec_hash": m["feature_spec_hash"],
            "artefact_sha256": m["artefact_sha256"],
            "training_data": {k: v for k, v in m["training_data"].items() if k != "test_drivers"},
            "demonstration": self.demonstration,
            "metrics": {
                **{label: {key: metrics[label][key] for key in ("positive_rate", "mean_probability", "model", "rules", "by_depot")} for label in LABELS},
                "decision": metrics["decision"],
                "test": metrics["test"],
            },
            "minimum": minimum(),
        }


def newest(models_dir: Path) -> Path | None:
    """The newest trip risk version in the folder (tr-2026.11.2 after tr-2026.11), or None: the service runs without one."""
    if not models_dir.is_dir():
        return None
    versions = [p for p in models_dir.glob("tr-*") if p.is_dir() and VERSION.match(p.name)]
    return max(versions, key=lambda p: tuple(int(n) for n in re.findall(r"\d+", p.name))) if versions else None
