"""trip_risk_spec.json: the trip risk model's inputs and labels, shared with the core's extractor (FMS-155)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from ml.spec import hash_of

SPEC_PATH = Path(__file__).resolve().parent.parent.parent / "trip_risk_spec.json"

MODEL_NAME = "trip-risk"
LABELS = ("late", "safety_event")
SOURCES = ("fleet", "generated")


@lru_cache(maxsize=1)
def load_spec() -> dict[str, Any]:
    with SPEC_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def feature_names() -> list[str]:
    """The inputs, in the order the model takes them."""
    return [f["name"] for f in load_spec()["features"]]


def id_columns() -> list[str]:
    return [c["name"] for c in load_spec()["id_columns"]]


def columns() -> list[str]:
    """Every column of a dataset row, in file order."""
    return [*id_columns(), *feature_names(), *LABELS]


def minimum() -> dict[str, int]:
    """The least data the model is trained on: {"trips": 2000, "drivers": 20}."""
    return dict(load_spec()["minimum"])


def spec_hash() -> str:
    return hash_of(load_spec())
