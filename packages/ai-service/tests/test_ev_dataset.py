"""The EV predictive maintenance spec and synthetic dataset (FMS-134): feature_spec_ev.json and ml/ev."""

import copy
import re

import pandas as pd
import pytest

from ml import spec as combustion
from ml.checks import problems
from ml.ev import dataset as ev_dataset
from ml.ev import spec
from ml.ev.dataset import MONTHS, VEHICLES, generate, to_csv

import generate_ev_training_data as cli

# maintenance.failure_component (FMS-125, migration 036) with the EV components (FMS-134, migration 086).
EV_COMPONENTS = ["traction_battery", "motor_inverter", "charging_system", "thermal_management"]
# What an EV has of the combustion spec's inputs; everything else of it is the engine's.
SHARED = [
    "mileage_km",
    "days_since_last_service",
    "num_fault_reports",
    "age_years",
    "days_since_coolant_change",
    "km_since_brake_pad_change",
    "days_since_brake_fluid_change",
    "km_since_tyre_change",
    "days_since_tyre_change",
    "days_since_battery_change",
]
EV_INPUTS = [
    "battery_health_pct",
    "battery_health_drop_90d",
    "high_temp_hours_30d",
    "energy_vs_expected_pct",
    "dc_fast_share_pct",
    "deep_discharges_30d",
    "failed_charging_sessions_90d",
]


@pytest.fixture(scope="module")
def df():
    return generate()


# The spec.


def test_the_shared_inputs_then_the_battery_and_charging_ones_in_order():
    assert spec.feature_names() == SHARED + EV_INPUTS


def test_every_input_says_its_source_tables_formula_window_range_and_fallback():
    for f in spec.load_spec()["features"]:
        assert {"name", "type", "unit", "min", "max", "decimals", "window_days", "sources", "formula", "when_missing"} <= set(f), f["name"]
        assert f["type"] in {"int", "float"} and f["min"] < f["max"]
        assert f["sources"] and all(re.fullmatch(r"[a-z_]+\.[a-z_]+", s) for s in f["sources"])
        assert f["formula"] and f["when_missing"]
    by_name = {f["name"]: f for f in spec.load_spec()["features"]}
    for name in EV_INPUTS:
        assert set(by_name[name]["sources"]) & {"ev.ev_battery_logs", "ev.charging_sessions"}, name
        assert isinstance(by_name[name]["window_days"], int), name


def test_the_shared_inputs_are_defined_as_for_combustion_vehicles():
    theirs = {f["name"]: f for f in combustion.load_spec()["features"]}
    for f in spec.load_spec()["features"]:
        if f["name"] in SHARED:
            mine = {k: v for k, v in f.items() if k != "formula"}
            assert mine == {k: v for k, v in theirs[f["name"]].items() if k != "formula"}, f["name"]


def test_no_combustion_only_input_is_in_the_ev_spec():
    for name in spec.feature_names():
        assert not any(word in name for word in spec.COMBUSTION_ONLY), name
    assert not set(spec.load_spec()["service_items"]["values"]) & {"engine_oil", "air_filter", "fuel_filter", "clutch_fluid", "gearbox_oil", "belts"}


def test_the_battery_health_fallback_reads_a_typical_battery_until_battery_logs_exist():
    health = next(f for f in spec.load_spec()["features"] if f["name"] == "battery_health_pct")
    assert "100 - 2 x age_years" in health["when_missing"]


def test_the_label_is_the_combustion_label_and_the_components_include_the_ev_ones():
    loaded = spec.load_spec()
    assert loaded["target"] == combustion.load_spec()["target"]
    assert loaded["component"]["values"][0] == "none"
    assert set(EV_COMPONENTS) <= set(loaded["component"]["values"])
    assert not set(loaded["component"]["values"]) & {"engine", "fuel_system", "exhaust", "transmission"}
    assert ev_dataset.COMPONENTS == loaded["component"]["values"][1:]


def test_the_hash_is_pinned_and_changes_with_any_input_definition(monkeypatch):
    first = spec.spec_hash()
    # The EV spec's hash, stored with an EV model in the registry (FMS-127, FMS-135): a change to the spec changes it.
    assert first == "e19b1ce3486fb2a2100a320b7dc1327f4b007fcb9397a2487fbff30d974dc428"
    assert first != combustion.spec_hash()
    changed = copy.deepcopy(spec.load_spec())
    changed["features"][-1]["window_days"] = 60
    monkeypatch.setattr(spec, "load_spec", lambda: changed)
    assert spec.spec_hash() != first


# The dataset.


def test_12000_checked_rows_with_15_to_25_percent_positive(df):
    assert len(df) == 12000 == VEHICLES * MONTHS
    assert list(df.columns) == spec.columns()
    assert problems(df, rows=12000, months=24, spec=spec.load_spec()) == []
    assert 0.15 <= df["failure_within_30_days"].mean() <= 0.25


def test_the_same_seed_gives_the_same_bytes_and_another_seed_other_data(tmp_path, df):
    first, second = tmp_path / "a.csv", tmp_path / "b.csv"
    to_csv(df, first)
    to_csv(generate(), second)
    assert first.read_bytes() == second.read_bytes()
    assert b"\r\n" not in first.read_bytes()
    assert not generate(seed=7).equals(df)


def test_a_degraded_hot_battery_fails_far_more_often(df):
    y = df["failure_within_30_days"]
    degraded, healthy = df["battery_health_pct"] < 82, df["battery_health_pct"] >= 92
    hot, cool = df["high_temp_hours_30d"] > 150, df["high_temp_hours_30d"] < 30
    assert degraded.sum() > 100 and hot.sum() > 100
    assert y[degraded].mean() > 2 * y[healthy].mean()
    assert y[hot].mean() > 3 * y[cool].mean()
    # And the traction battery is what a degraded pack loses, the thermal loop what a hot one does.
    failed = df[y == 1]
    assert (failed.loc[failed["battery_health_pct"] < 82, "failure_component"] == "traction_battery").mean() > 0.3
    assert (failed.loc[failed["high_temp_hours_30d"] > 150, "failure_component"] == "thermal_management").mean() > 0.2


def test_the_label_is_not_a_rule_on_the_inputs(df):
    alike = pd.DataFrame(
        {
            "health": df["battery_health_pct"] // 4,
            "heat": df["high_temp_hours_30d"] // 40,
            "faults": df["num_fault_reports"].clip(upper=3),
            "service": df["days_since_last_service"] // 45,
        }
    ).astype(str).agg("|".join, axis=1)
    rates = df.groupby(alike)["failure_within_30_days"].agg(["mean", "size"])
    big = rates[rates["size"] >= 50]
    assert len(big) > 10
    assert ((big["mean"] > 0.03) & (big["mean"] < 0.97)).mean() > 0.5


def test_the_pack_ages_and_a_battery_repair_restores_it(df):
    one = df[df["vehicle_id"] == "SYN-EV-0001"]
    assert (one["battery_health_pct"].diff().dropna() < 0).mean() > 0.6
    after = df.groupby("vehicle_id")["battery_health_pct"].shift(-1)
    battery_repaired = (df["failure_component"] == "traction_battery") & after.notna()
    assert (after[battery_repaired] >= 90).mean() > 0.9


def test_failures_name_ev_catalogue_components(df):
    failed = df.loc[df["failure_within_30_days"] == 1, "failure_component"]
    assert set(failed) <= set(ev_dataset.COMPONENTS)
    assert failed.value_counts().index[0] == "traction_battery"
    assert set(EV_COMPONENTS) <= set(failed)


def test_a_random_forest_ranks_risk_on_vehicles_it_has_not_seen(df):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import GroupShuffleSplit

    X, y = df[spec.feature_names()], df["failure_within_30_days"]
    train, test = next(GroupShuffleSplit(1, test_size=0.2, random_state=0).split(X, y, df["vehicle_id"]))
    model = RandomForestClassifier(n_estimators=300, min_samples_leaf=5, class_weight="balanced", random_state=0, n_jobs=-1)
    model.fit(X.iloc[train], y.iloc[train])
    auc = roc_auc_score(y.iloc[test], model.predict_proba(X.iloc[test])[:, 1])
    # The card's bar, and below perfect: the frailty the model cannot see keeps it honest.
    assert 0.75 <= auc <= 0.90


# The checks, on the EV spec.


@pytest.mark.parametrize(
    "damage, expected",
    [
        (lambda d: d.drop(columns=["dc_fast_share_pct"]), "columns are"),
        (lambda d: d.assign(battery_health_pct=d["battery_health_pct"].where(d.index != 0, 120.0)), "battery_health_pct: range"),
        (lambda d: d.assign(deep_discharges_30d=d["deep_discharges_30d"] + 0.5), "deep_discharges_30d: not whole numbers"),
        (lambda d: d.assign(failure_within_30_days=0, failure_component="none"), "positive rate"),
        (lambda d: d.assign(failure_component=d["failure_component"].replace("traction_battery", "engine")), "values outside the FMS-125 catalogue"),
        (lambda d: d.assign(failure_component="none"), "must be none exactly when"),
        (lambda d: pd.concat([d, d.iloc[[0]]], ignore_index=True), "two rows for one as_of"),
        (lambda d: d.iloc[1:], "exactly 24 rows"),
        (lambda d: d.assign(energy_vs_expected_pct=d["energy_vs_expected_pct"].astype(object).where(d.index != 3, None)), "nulls"),
    ],
)
def test_every_quality_check_catches_what_it_is_for(df, damage, expected):
    found = problems(damage(df.copy()), rows=None, months=24, spec=spec.load_spec())
    assert any(expected in line for line in found), found


def test_the_script_writes_the_csv_and_refuses_data_that_fails_its_checks(tmp_path, monkeypatch, capsys):
    out = tmp_path / "ev_training_data.csv"
    assert cli.main(["--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").count("\n") == 12001
    assert "EV feature spec hash: " + spec.spec_hash() in capsys.readouterr().out

    broken = tmp_path / "broken.csv"
    monkeypatch.setattr(cli, "generate", lambda seed: generate(seed=seed).assign(failure_within_30_days=0, failure_component="none"))
    assert cli.main(["--out", str(broken)]) == 1
    assert not broken.exists()
    assert "positive rate" in capsys.readouterr().err
