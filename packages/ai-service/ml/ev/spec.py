"""feature_spec_ev.json: the EV predictive maintenance model's inputs and label (FMS-134), hashed as feature_spec.json is."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from ml.spec import hash_of

SPEC_PATH = Path(__file__).resolve().parent.parent.parent / "feature_spec_ev.json"

# What an electric vehicle does not have: no input reads them (the reason for a spec of its own, FMS-134).
COMBUSTION_ONLY = ("oil", "fuel", "belt", "gearbox", "clutch", "air_filter", "engine_hours")


@lru_cache(maxsize=1)
def load_spec() -> dict[str, Any]:
    with SPEC_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def feature_names() -> list[str]:
    """The inputs, in the order the model takes them."""
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
    """SHA-256 of the inputs and label, as ml.spec.spec_hash: the model registry (FMS-127) stores it with an EV model."""
    return hash_of(load_spec())
