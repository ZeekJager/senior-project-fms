"""The synthetic training dataset (FMS-52)."""

import pandas as pd
import pytest

from ml import dataset
from ml.checks import problems
from ml.dataset import MONTHS, VEHICLES, generate, to_csv
from ml.spec import columns, feature_names

import generate_training_data as cli


@pytest.fixture(scope="module")
def df():
    return generate()


def test_12000_rows_in_the_spec_columns_with_no_nulls_and_every_check_passing(df):
    assert len(df) == 12000 == VEHICLES * MONTHS
    assert list(df.columns) == columns()
    assert int(df.isna().sum().sum()) == 0
    assert problems(df, rows=12000, months=24) == []


def test_15_to_25_percent_positive(df):
    assert 0.15 <= df["failure_within_30_days"].mean() <= 0.25


def test_the_same_seed_gives_the_same_bytes_and_another_seed_other_data(tmp_path, df):
    first, second = tmp_path / "a.csv", tmp_path / "b.csv"
    to_csv(df, first)
    to_csv(generate(), second)
    assert first.read_bytes() == second.read_bytes()
    assert b"\r\n" not in first.read_bytes()
    assert not generate(seed=7).equals(df)


def test_the_signal_the_model_must_learn_is_there(df):
    y = df["failure_within_30_days"]
    overdue_and_faulty = (df["days_since_last_service"] > 90) & (df["num_fault_reports"] >= 3)
    recently_serviced_no_faults = (df["days_since_last_service"] <= 30) & (df["num_fault_reports"] == 0)
    assert overdue_and_faulty.sum() > 100 and y[overdue_and_faulty].mean() >= 0.6
    assert recently_serviced_no_faults.sum() > 500 and y[recently_serviced_no_faults].mean() <= 0.10


def test_the_label_is_not_a_rule_on_the_features(df):
    # Vehicles alike in the strongest clues still differ in outcome: chance and what the model cannot see matter too.
    alike = pd.DataFrame(
        {
            "service": df["days_since_last_service"] // 30,
            "faults": df["num_fault_reports"].clip(upper=4),
            "oil": df["km_since_oil_change"] // 6000,
            "age": df["age_years"] // 5,
        }
    ).astype(str).agg("|".join, axis=1)
    rates = df.groupby(alike)["failure_within_30_days"].agg(["mean", "size"])
    big = rates[rates["size"] >= 50]
    assert len(big) > 10
    assert ((big["mean"] > 0.05) & (big["mean"] < 0.95)).mean() > 0.5


def test_a_vehicle_barely_driven_has_no_fuel_variance(df):
    idle = df[df["mileage_km"] < 100]
    assert len(idle) > 0
    assert (idle["fuel_variance_pct"] == 0).all()


def test_failures_name_catalogue_components_with_wear_parts_most_common(df):
    failed = df.loc[df["failure_within_30_days"] == 1, "failure_component"]
    assert set(failed) <= set(dataset.COMPONENTS)
    counts = failed.value_counts()
    assert set(counts.index[:3]) & {"brakes", "tyres"}
    assert (df.loc[df["failure_within_30_days"] == 0, "failure_component"] == "none").all()


def test_a_random_forest_learns_it_on_vehicles_it_has_not_seen(df):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import GroupShuffleSplit

    X, y = df[feature_names()], df["failure_within_30_days"]
    train, test = next(GroupShuffleSplit(1, test_size=0.2, random_state=0).split(X, y, df["vehicle_id"]))
    model = RandomForestClassifier(n_estimators=300, min_samples_leaf=5, class_weight="balanced", random_state=0, n_jobs=-1)
    model.fit(X.iloc[train], y.iloc[train])
    auc = roc_auc_score(y.iloc[test], model.predict_proba(X.iloc[test])[:, 1])
    # Well above chance, well below perfect: the frailty the model cannot see keeps it honest.
    assert 0.72 <= auc <= 0.88
    risky, healthy = example(X, 100, 5), example(X, 10, 0)
    p_risky, p_healthy = model.predict_proba(pd.DataFrame([risky, healthy]))[:, 1]
    # The board's examples (FMS-53): health = round((1 - p) * 100).
    assert round((1 - p_risky) * 100) < 30
    assert round((1 - p_healthy) * 100) > 85


def example(X, days_since_service, faults):
    """A typical vehicle with this service age and these faults. The oil is changed at every service, so its age follows."""
    row = X.median()
    row["days_since_last_service"], row["num_fault_reports"] = days_since_service, faults
    row["days_since_oil_change"] = days_since_service
    row["km_since_oil_change"] = round(days_since_service * row["mileage_km"] / 30, 1)
    return row


def test_parts_age_and_are_renewed(df):
    # Each counter grows month to month and drops back when the part is changed; some parts run past due.
    one = df[df["vehicle_id"] == "SYN-0001"]
    for name in ["km_since_brake_pad_change", "days_since_coolant_change", "km_since_oil_change"]:
        steps = one[name].diff().dropna()
        assert (steps > 0).any() and (steps < 0).any(), name
    assert (df["km_since_brake_pad_change"] > 45_000).mean() > 0.05
    assert (df["days_since_coolant_change"] > 730).mean() > 0.05


def test_the_oil_is_never_older_than_the_last_service(df):
    # Every service changes the oil on the same day; an engine repair may change it in between.
    assert (df["days_since_oil_change"] <= df["days_since_last_service"]).all()
    assert (df["days_since_oil_change"] == df["days_since_last_service"]).mean() > 0.8


def test_an_overdue_part_fails_its_component_more_often(df):
    failed = df[df["failure_within_30_days"] == 1]
    for feature, due, component in [
        ("km_since_brake_pad_change", 45_000, "brakes"),
        ("days_since_coolant_change", 730, "cooling"),
        ("days_since_battery_change", 1_460, "electrical"),
    ]:
        late = failed[feature] > due
        assert late.sum() > 20, feature
        share_late = (failed.loc[late, "failure_component"] == component).mean()
        share_on_time = (failed.loc[~late, "failure_component"] == component).mean()
        assert share_late > 2 * share_on_time, (feature, share_late, share_on_time)


def test_the_script_writes_the_csv_and_refuses_data_that_fails_its_checks(tmp_path, monkeypatch, capsys):
    out = tmp_path / "training_data.csv"
    assert cli.main(["--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").count("\n") == 12001
    assert "feature spec hash:" in capsys.readouterr().out

    broken = tmp_path / "broken.csv"
    monkeypatch.setattr(cli, "generate", lambda seed: generate(seed=seed).assign(failure_within_30_days=0, failure_component="none"))
    assert cli.main(["--out", str(broken)]) == 1
    assert not broken.exists()
    assert "positive rate" in capsys.readouterr().err
