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
    # Rows identical in every input but with different labels: something the model cannot see matters too.
    rounded = df[feature_names()].round(-1).astype(str).agg("|".join, axis=1)
    mixed = df.groupby(rounded)["failure_within_30_days"].nunique()
    assert (mixed > 1).sum() > 0


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
    model = RandomForestClassifier(n_estimators=150, min_samples_leaf=5, random_state=0, n_jobs=-1).fit(X.iloc[train], y.iloc[train])
    auc = roc_auc_score(y.iloc[test], model.predict_proba(X.iloc[test])[:, 1])
    # Well above chance, well below perfect: the frailty the model cannot see keeps it honest.
    assert 0.70 <= auc <= 0.85
    median = X.median()
    risky = median.copy()
    risky["days_since_last_service"], risky["num_fault_reports"] = 100, 5
    healthy = median.copy()
    healthy["days_since_last_service"], healthy["num_fault_reports"] = 10, 0
    p_risky, p_healthy = model.predict_proba(pd.DataFrame([risky, healthy]))[:, 1]
    # The board's examples (FMS-53): health = round((1 - p) * 100).
    assert round((1 - p_risky) * 100) < 30
    assert round((1 - p_healthy) * 100) > 85


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
