"""
The synthetic training dataset (FMS-52): 500 vehicles, each scored on the
first day of 24 consecutive months, in the columns of feature_spec.json.

The fleet does not have months of real history yet, so the rows come from a
small simulation rather than from rules on the features. Each vehicle has
fixed traits (age, how hard it is driven, how often it is serviced) and a
hidden frailty the model never sees. Month by month its service clock runs
and resets, faults are reported, fuel use drifts, and it breaks down or not
with a probability that rises with the same causes. A breakdown is repaired:
its fault history clears. So the label depends on the features, but not only
on them: no rule on the six inputs reproduces it, and a model trained on it
has to generalise rather than recover a formula.

Every draw comes from one seeded generator (numpy PCG64) in a fixed order,
so the same seed gives the same bytes on every run.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from .spec import columns, load_spec

SEED = 42
VEHICLES = 500
MONTHS = 24
FIRST_MONTH = date(2024, 10, 1)

# Components that fail, from the FMS-125 catalogue, with what drives each (see _components).
COMPONENTS = ["engine", "cooling", "brakes", "tyres", "transmission", "electrical", "suspension", "steering", "fuel_system", "exhaust", "body", "other"]


def _months(first: date, n: int) -> list[str]:
    out = []
    y, m = first.year, first.month
    for _ in range(n):
        out.append(date(y, m, 1).isoformat())
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def failure_logit(
    days_since_service: np.ndarray,
    faults: np.ndarray,
    age: np.ndarray,
    mileage: np.ndarray,
    fuel_variance: np.ndarray,
    frailty: np.ndarray,
) -> np.ndarray:
    """
    Log-odds of an unplanned failure in the next 30 days. Overdue service and
    reported faults dominate, together most of all (the board's "over 90 days
    and 3 or more faults" case); hard use of an old vehicle adds its own risk;
    rising fuel use is an early sign. The frailty term is not in the dataset.
    """
    overdue = np.clip((days_since_service - 60.0) / 30.0, -2.0, 6.0)
    return (
        -3.55
        + 0.55 * overdue
        + 0.45 * np.minimum(faults, 8)
        + 0.10 * age
        + 0.12 * mileage / 1000.0
        + 0.04 * np.clip(fuel_variance, -10.0, 40.0)
        + 1.30 * ((days_since_service > 90) & (faults >= 3))
        + 0.80 * ((mileage > 6000) & (age > 10))
        + frailty
    )


def _components(rng: np.random.Generator, mileage, age, fuel_variance) -> np.ndarray:
    """Which component failed: wear parts follow distance, older vehicles fail in the engine and cooling."""
    fv = np.maximum(fuel_variance, 0.0)
    weights = np.stack(
        [
            0.5 + age / 6.0,  # engine
            0.4 + age / 8.0 + fv / 10.0,  # cooling
            1.0 + mileage / 3000.0,  # brakes
            1.0 + mileage / 4000.0,  # tyres
            0.4 + mileage / 6000.0,  # transmission
            np.full_like(age, 0.8),  # electrical
            0.6 + mileage / 5000.0,  # suspension
            np.full_like(age, 0.2),  # steering
            0.3 + fv / 8.0,  # fuel_system
            np.full_like(age, 0.2),  # exhaust
            np.full_like(age, 0.2),  # body
            np.full_like(age, 0.2),  # other
        ],
        axis=1,
    )
    cumulative = np.cumsum(weights / weights.sum(axis=1, keepdims=True), axis=1)
    roll = rng.random(len(age))[:, None]
    return np.asarray(COMPONENTS)[np.minimum((roll > cumulative).sum(axis=1), len(COMPONENTS) - 1)]


def generate(seed: int = SEED, vehicles: int = VEHICLES, months: int = MONTHS, first_month: date = FIRST_MONTH) -> pd.DataFrame:
    """The dataset as a DataFrame in feature_spec.json's column order, by vehicle, then month."""
    rng = np.random.default_rng(seed)
    spec = {f["name"]: f for f in load_spec()["features"]}

    # Fixed traits.
    age0 = rng.uniform(0.5, 14.0, vehicles)
    usage = np.clip(rng.lognormal(np.log(3500.0), 0.45, vehicles), 400.0, 12000.0)
    speed = rng.uniform(32.0, 55.0, vehicles)
    interval = rng.uniform(45.0, 160.0, vehicles)
    frailty = rng.normal(0.0, 0.6, vehicles)
    fuel_bias = rng.normal(0.0, 3.0, vehicles)

    # State going into the first month: the service clock, and the faults of the two months before.
    days_since_service = rng.integers(0, 151, vehicles).astype(float)
    fault_history = [rng.poisson(0.2, vehicles), rng.poisson(0.2, vehicles)]

    as_of = _months(first_month, months)
    frames = []
    for m in range(months):
        # Some months a vehicle barely moves (in the workshop, no work): the rules for little driving apply.
        idle = rng.random(vehicles) < 0.03
        mileage = usage * rng.gamma(8.0, 1.0 / 8.0, vehicles) * np.where(idle, 0.01, 1.0)
        mileage = np.clip(mileage, 0.0, spec["mileage_km"]["max"])
        engine_hours = np.clip(mileage / (speed * rng.uniform(0.9, 1.1, vehicles)), 0.0, spec["engine_hours"]["max"])
        age = age0 + m / 12.0

        overdue = np.maximum(days_since_service - 60.0, 0.0) / 60.0
        fault_rate = 0.15 + 0.35 * overdue + 0.08 * age / 5.0 + 0.30 * np.maximum(frailty, 0.0)
        this_month = rng.poisson(fault_rate)
        faults = np.minimum(fault_history[0] + fault_history[1] + this_month, spec["num_fault_reports"]["max"])

        fuel_variance = (
            fuel_bias
            + 1.5 * np.maximum(days_since_service - 90.0, 0.0) / 30.0
            + 2.0 * np.maximum(frailty, 0.0)
            + rng.normal(0.0, 2.5, vehicles)
        )
        # Too little driving to judge consumption: the core reports 0.
        fuel_variance = np.where(mileage < 100.0, 0.0, fuel_variance)
        fuel_variance = np.clip(fuel_variance, spec["fuel_variance_pct"]["min"], spec["fuel_variance_pct"]["max"])

        dss = np.minimum(days_since_service, spec["days_since_last_service"]["max"])
        p = _sigmoid(failure_logit(dss, faults, age, mileage, fuel_variance, frailty))
        failed = rng.random(vehicles) < p
        component = np.where(failed, _components(rng, mileage, age, fuel_variance), "none")

        frames.append(
            pd.DataFrame(
                {
                    "vehicle_id": [f"SYN-{i + 1:04d}" for i in range(vehicles)],
                    "as_of": as_of[m],
                    "mileage_km": np.round(mileage, 1),
                    "engine_hours": np.round(engine_hours, 1),
                    "days_since_last_service": dss.astype(int),
                    "num_fault_reports": faults.astype(int),
                    "fuel_variance_pct": np.round(fuel_variance, 1),
                    "age_years": np.round(np.clip(age, 0.0, spec["age_years"]["max"]), 1),
                    "failure_within_30_days": failed.astype(int),
                    "failure_component": component,
                }
            )
        )

        # The next month: a service is due once the clock passes the vehicle's
        # interval (give or take); a breakdown is repaired and its faults cleared.
        serviced = days_since_service + 30.0 >= interval * rng.uniform(0.8, 1.3, vehicles)
        days_since_service = np.where(serviced, rng.integers(0, 30, vehicles), days_since_service + 30.0)
        fault_history = [fault_history[1], np.where(failed, 0, this_month)]
        fault_history[0] = np.where(failed, 0, fault_history[0])

    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values(["vehicle_id", "as_of"], kind="mergesort").reset_index(drop=True)
    return df[columns()]


def to_csv(df: pd.DataFrame, path) -> None:
    """Fixed formatting and line endings, so the same rows are the same bytes on every platform."""
    df.to_csv(path, index=False, lineterminator="\n", float_format="%.1f")
