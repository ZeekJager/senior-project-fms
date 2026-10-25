"""The feature spec (feature_spec.json): the model's inputs and label, shared with the core's feature extractor."""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

SPEC_PATH = Path(__file__).resolve().parent.parent / "feature_spec.json"


@lru_cache(maxsize=1)
def load_spec() -> dict[str, Any]:
    with SPEC_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def feature_names() -> list[str]:
    """The model's inputs, in the order the model takes them."""
    return [f["name"] for f in load_spec()["features"]]


def id_columns() -> list[str]:
    return [c["name"] for c in load_spec()["id_columns"]]


def target_name() -> str:
    return load_spec()["target"]["name"]


def component_name() -> str:
    return load_spec()["component"]["name"]


def columns() -> list[str]:
    """Every column of a dataset row, in file order."""
    return [*id_columns(), *feature_names(), target_name(), component_name()]


def spec_hash() -> str:
    """
    SHA-256 of the inputs and label: names, order, types, ranges, windows and
    formulas. Two models with the same hash take the same inputs; the model
    registry (FMS-127) stores it, and the core refuses a model whose hash is
    not the one its extractor implements.
    """
    spec = load_spec()
    canonical = json.dumps(
        {"features": spec["features"], "target": spec["target"]},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
