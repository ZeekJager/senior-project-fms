"""The feature spec (feature_spec.json): one source for training, the service and the core's extractor."""

import copy
import re

from ml import spec
from ml.dataset import COMPONENTS, ITEMS

# The board's six inputs (FMS-52/54), first and in order; then how long since each wearing part and fluid was changed.
BOARD_INPUTS = ["mileage_km", "engine_hours", "days_since_last_service", "num_fault_reports", "fuel_variance_pct", "age_years"]
PART_INPUTS = [
    "days_since_oil_change",
    "km_since_oil_change",
    "km_since_air_filter_change",
    "km_since_fuel_filter_change",
    "days_since_coolant_change",
    "km_since_brake_pad_change",
    "days_since_brake_fluid_change",
    "days_since_clutch_fluid_change",
    "km_since_tyre_change",
    "days_since_tyre_change",
    "days_since_battery_change",
    "km_since_gearbox_oil_change",
    "km_since_belt_change",
]

# maintenance.service_item (migration 037).
SERVICE_ITEMS = ["engine_oil", "air_filter", "fuel_filter", "coolant", "brake_pads", "brake_fluid", "clutch_fluid", "tyres", "battery", "gearbox_oil", "belts"]

# maintenance.failure_component (FMS-125, migration 036).
FAILURE_CATALOGUE = ["engine", "cooling", "brakes", "tyres", "transmission", "electrical", "suspension", "steering", "fuel_system", "exhaust", "body", "other"]


def test_the_board_inputs_then_the_part_history_in_order():
    assert spec.feature_names() == BOARD_INPUTS + PART_INPUTS


def test_every_part_input_reads_a_service_item_the_generator_simulates():
    loaded = spec.load_spec()
    assert loaded["service_items"]["values"] == SERVICE_ITEMS == [item.name for item in ITEMS]
    by_name = {f["name"]: f for f in loaded["features"]}
    for item in ITEMS:
        for name, unit in item.features:
            assert by_name[name]["service_item"] == item.name
            assert by_name[name]["unit"] == ("km" if unit == "km" else "d")
            assert "service_item is " + item.name in by_name[name]["formula"]
    assert {n for item in ITEMS for n, _ in item.features} == set(PART_INPUTS)


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


def test_the_core_hashes_the_spec_to_the_same_value():
    # The core computes the same SHA-256 in Node (FMS-127, backend domain/ml-model.test.ts) and refuses to score with a
    # model whose hash is not its own. A change to the spec changes it on both sides: update both tests' value.
    assert spec.spec_hash() == "b81af7ff0446aaf63946fcb12fae3a4b0cccaeecbc1a94d04d2b035a048e2f10"
