"""The feature spec (feature_spec.json): one source for training, the service and the core's extractor."""

import copy
import re

from ml import spec
from ml.dataset import COMPONENTS

# The inputs POST /predict takes (FMS-54), in order.
SERVICE_INPUTS = ["mileage_km", "engine_hours", "days_since_last_service", "num_fault_reports", "fuel_variance_pct", "age_years"]

# maintenance.failure_component (FMS-125, migration 036).
FAILURE_CATALOGUE = ["engine", "cooling", "brakes", "tyres", "transmission", "electrical", "suspension", "steering", "fuel_system", "exhaust", "body", "other"]


def test_the_six_inputs_the_service_takes_in_its_order():
    assert spec.feature_names() == SERVICE_INPUTS


def test_every_feature_says_where_it_comes_from_and_how_it_is_computed():
    for f in spec.load_spec()["features"]:
        assert {"name", "type", "unit", "min", "max", "decimals", "window_days", "sources", "formula", "when_missing"} <= set(f), f["name"]
        assert f["type"] in {"int", "float"}
        assert f["min"] < f["max"]
        assert f["sources"] and all(re.fullmatch(r"[a-z_]+\.[a-z_]+", s) for s in f["sources"])
        assert f["formula"] and f["when_missing"]


def test_the_label_is_defined_on_failure_records_and_never_an_input():
    target = spec.load_spec()["target"]
    assert target["name"] == "failure_within_30_days"
    assert target["sources"] == ["maintenance.failure_events"]
    assert "unplanned = true" in target["definition"]
    assert target["name"] not in spec.feature_names()
    assert not set(spec.id_columns()) & set(spec.feature_names())


def test_components_are_the_failure_catalogue():
    assert spec.load_spec()["component"]["values"] == ["none", *FAILURE_CATALOGUE]
    assert COMPONENTS == FAILURE_CATALOGUE


def test_the_hash_is_stable_and_changes_with_any_input_definition(monkeypatch):
    first = spec.spec_hash()
    assert re.fullmatch(r"[0-9a-f]{64}", first)
    assert spec.spec_hash() == first

    changed = copy.deepcopy(spec.load_spec())
    changed["features"][0]["window_days"] = 31
    monkeypatch.setattr(spec, "load_spec", lambda: changed)
    second = spec.spec_hash()
    assert second != first

    # Prose outside the inputs and label does not change it.
    reworded = copy.deepcopy(changed)
    reworded["description"] = "Reworded."
    reworded["id_columns"][0]["description"] = "Reworded."
    monkeypatch.setattr(spec, "load_spec", lambda: reworded)
    assert spec.spec_hash() == second
