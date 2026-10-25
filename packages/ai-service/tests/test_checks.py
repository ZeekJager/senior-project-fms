"""The data quality checks (FMS-52) catch what they promise to."""

import numpy as np
import pytest

from ml.checks import problems
from ml.dataset import generate


@pytest.fixture(scope="module")
def good():
    return generate(vehicles=60, months=24)


def test_a_good_dataset_has_no_problems(good):
    assert problems(good, rows=1440, months=24) == []


def test_the_wrong_row_count_or_columns(good):
    assert problems(good, rows=12000) == ["1440 rows, expected 12000"]
    assert "columns are" in problems(good.drop(columns=["age_years"]))[0]
    assert "columns are" in problems(good[list(reversed(good.columns))])[0]


def test_nulls_are_named_by_column(good):
    bad = good.copy()
    bad.loc[3, "fuel_variance_pct"] = np.nan
    assert problems(bad) == ["fuel_variance_pct: 1 nulls"]


def test_a_value_outside_its_range_or_precision(good):
    bad = good.copy()
    bad.loc[0, "mileage_km"] = 20000.0
    bad.loc[1, "fuel_variance_pct"] = 1.25
    found = problems(bad)
    assert any(p.startswith("mileage_km: range") for p in found)
    assert "fuel_variance_pct: more than 1 decimals" in found


def test_a_positive_rate_outside_15_to_25_percent(good):
    none_failed = good.assign(failure_within_30_days=0, failure_component="none")
    assert any("positive rate 0.000" in p for p in problems(none_failed))


def test_a_component_outside_the_catalogue_or_on_the_wrong_rows(good):
    bad = good.copy()
    first_failure = bad.index[bad["failure_within_30_days"] == 1][0]
    bad.loc[first_failure, "failure_component"] = "flux_capacitor"
    assert "failure_component: values outside the FMS-125 catalogue" in problems(bad)
    bad.loc[first_failure, "failure_component"] = "none"
    assert "failure_component: must be none exactly when failure_within_30_days is 0" in problems(bad)


def test_a_missing_or_repeated_month(good):
    skipped = good[~((good["vehicle_id"] == "SYN-0001") & (good["as_of"] == "2024-12-01"))].reset_index(drop=True)
    found = problems(skipped, months=24)
    assert "a vehicle does not have exactly 24 rows" in found
    assert "as_of: a vehicle's months are not consecutive" in found
    repeated = good.copy()
    repeated.loc[1, "as_of"] = repeated.loc[0, "as_of"]
    assert "a vehicle has two rows for one as_of" in problems(repeated)
