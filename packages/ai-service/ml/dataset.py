"""
The synthetic training dataset (FMS-52): 500 vehicles, each scored on the
first day of 24 consecutive months, in the columns of feature_spec.json.

The fleet does not have months of real history yet, so the rows come from a
small simulation rather than from rules on the features. Each vehicle has
fixed traits (age, how hard it is driven, how often it is serviced, how well
it keeps up each part) and a hidden frailty the model never sees. Month by
month it drives; its service clock runs and resets; each wearing part and
fluid ages by distance or time and is changed when its owner gets round to
it; faults are reported and fuel use drifts. It breaks down or not with a
probability that rises with the same causes, mostly with the parts that are
overdue, and the part that fails is most often an overdue one. A breakdown is
repaired: the failed part is renewed and the fault history clears. So the
label depends on the features, but not only on them: no rule on the inputs
reproduces it, and a model trained on it has to generalise rather than
recover a formula.

Every draw comes from one seeded generator (numpy PCG64) in a fixed order,
so the same seed gives the same bytes on every run.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from .spec import columns, load_spec

SEED = 42
VEHICLES = 500
MONTHS = 24
FIRST_MONTH = date(2024, 10, 1)
# Months simulated before the first recorded one, so the fleet has settled: without them every vehicle
# starts with its parts at random ages, and the first month is a wave of breakdowns.
WARM_UP_MONTHS = 12

# Components that fail, from the FMS-125 catalogue.
COMPONENTS = ["engine", "cooling", "brakes", "tyres", "transmission", "electrical", "suspension", "steering", "fuel_system", "exhaust", "body", "other"]


@dataclass(frozen=True)
class Item:
    """A wearing part or fluid (maintenance.service_item): when it is due, and which components it protects."""

    name: str
    due_km: float | None
    due_days: float | None
    protects: tuple[str, ...]
    # The features that report it: (name, "km" or "days").
    features: tuple[tuple[str, str], ...]


# Typical truck intervals. Engine oil (and its filter) is changed at every service.
ITEMS = [
    Item("engine_oil", 12_000, 180, ("engine",), (("days_since_oil_change", "days"), ("km_since_oil_change", "km"))),
    Item("air_filter", 25_000, None, ("engine", "fuel_system"), (("km_since_air_filter_change", "km"),)),
    Item("fuel_filter", 30_000, None, ("fuel_system",), (("km_since_fuel_filter_change", "km"),)),
    Item("coolant", None, 730, ("cooling",), (("days_since_coolant_change", "days"),)),
    Item("brake_pads", 45_000, None, ("brakes",), (("km_since_brake_pad_change", "km"),)),
    Item("brake_fluid", None, 730, ("brakes",), (("days_since_brake_fluid_change", "days"),)),
    Item("clutch_fluid", None, 730, ("transmission",), (("days_since_clutch_fluid_change", "days"),)),
    Item("tyres", 80_000, 2_000, ("tyres",), (("km_since_tyre_change", "km"), ("days_since_tyre_change", "days"))),
    Item("battery", None, 1_460, ("electrical",), (("days_since_battery_change", "days"),)),
    Item("gearbox_oil", 80_000, None, ("transmission",), (("km_since_gearbox_oil_change", "km"),)),
    Item("belts", 80_000, None, ("engine", "electrical"), (("km_since_belt_change", "km"),)),
]

# A failed component is repaired: these items are renewed with it.
RENEWED_ON_FAILURE = {
    "engine": ("engine_oil", "belts"),
    "cooling": ("coolant",),
    "brakes": ("brake_pads", "brake_fluid"),
    "tyres": ("tyres",),
    "transmission": ("clutch_fluid", "gearbox_oil"),
    "electrical": ("battery",),
    "fuel_system": ("fuel_filter",),
}


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


def overdue(km: dict[str, np.ndarray], days: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """How far past due each item is: 0 up to 90% of its interval, then rising (1 = 100% past due)."""
    out = {}
    for item in ITEMS:
        ratio = np.zeros_like(next(iter(days.values())))
        if item.due_km:
            ratio = np.maximum(ratio, km[item.name] / item.due_km)
        if item.due_days:
            ratio = np.maximum(ratio, days[item.name] / item.due_days)
        out[item.name] = np.clip(ratio - 0.9, 0.0, 2.0)
    return out


def component_risk(late: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Each component's risk from its overdue items (0 when everything protecting it is on time)."""
    risk = {c: np.zeros_like(next(iter(late.values()))) for c in COMPONENTS}
    for item in ITEMS:
        for c in item.protects:
            risk[c] = risk[c] + late[item.name]
    return risk


def failure_logit(days_since_service, faults, age, mileage, fuel_variance, frailty, risk) -> np.ndarray:
    """
    Log-odds of an unplanned failure in the next 30 days. Overdue parts weigh
    most; overdue service and reported faults, together most of all, follow;
    hard use of an old vehicle and rising fuel use add theirs. The frailty term
    is not in the dataset.
    """
    late_service = np.clip((days_since_service - 60.0) / 30.0, -2.0, 6.0)
    parts = sum(np.minimum(r, 2.0) for r in risk.values())
    return (
        -4.60
        + 3.00 * np.minimum(parts, 4.0)
        + 0.50 * late_service
        + 0.45 * np.minimum(faults, 8)
        + 0.10 * age
        + 0.12 * mileage / 1000.0
        + 0.04 * np.clip(fuel_variance, -10.0, 40.0)
        + 2.00 * ((days_since_service > 90) & (faults >= 3))
        + 0.80 * ((mileage > 6000) & (age > 10))
        + frailty
    )


def _components(rng: np.random.Generator, mileage, age, fuel_variance, risk) -> np.ndarray:
    """Which component failed: mostly one whose parts are overdue; otherwise wear parts follow distance and old vehicles fail in the engine and cooling."""
    fv = np.maximum(fuel_variance, 0.0)
    base = {
        "engine": 0.5 + age / 6.0,
        "cooling": 0.4 + age / 8.0 + fv / 10.0,
        "brakes": 1.0 + mileage / 3000.0,
        "tyres": 1.0 + mileage / 4000.0,
        "transmission": 0.4 + mileage / 6000.0,
        "electrical": np.full_like(age, 0.8),
        "suspension": 0.6 + mileage / 5000.0,
        "steering": np.full_like(age, 0.2),
        "fuel_system": 0.3 + fv / 8.0,
        "exhaust": np.full_like(age, 0.2),
        "body": np.full_like(age, 0.2),
        "other": np.full_like(age, 0.2),
    }
    weights = np.stack([base[c] * np.exp(3.5 * np.minimum(risk[c], 2.0)) for c in COMPONENTS], axis=1)
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
    # How late each owner changes each item, relative to its interval (1 = on time; most run a little
    # late): some keep up the oil and let the coolant go; a few neglect everything.
    neglect = rng.lognormal(0.15, 0.4, vehicles)
    care = {item.name: neglect * rng.lognormal(0.0, 0.5, vehicles) for item in ITEMS}

    # State going into the warm-up: the service clock, the faults of the two months before, and how
    # long since each item was changed (anywhere up to well past due).
    days_since_service = rng.integers(0, 151, vehicles).astype(float)
    fault_history = [rng.poisson(0.2, vehicles), rng.poisson(0.2, vehicles)]
    km_since, days_since = {}, {}
    for item in ITEMS:
        start = rng.uniform(0.0, 1.2, vehicles) * care[item.name]
        km_since[item.name] = start * (item.due_km or usage * (item.due_days or 365) / 30.0)
        days_since[item.name] = start * (item.due_days or (item.due_km or 0) / usage * 30.0)

    as_of = _months(first_month, months)
    frames = []
    for m in range(-WARM_UP_MONTHS, months):
        # Some months a vehicle barely moves (in the workshop, no work): the rules for little driving apply.
        idle = rng.random(vehicles) < 0.03
        mileage = usage * rng.gamma(8.0, 1.0 / 8.0, vehicles) * np.where(idle, 0.01, 1.0)
        mileage = np.clip(mileage, 0.0, spec["mileage_km"]["max"])
        engine_hours = np.clip(mileage / (speed * rng.uniform(0.9, 1.1, vehicles)), 0.0, spec["engine_hours"]["max"])
        age = np.maximum(age0 + m / 12.0, 0.0)

        late = overdue(km_since, days_since)
        risk = component_risk(late)
        late_service = np.maximum(days_since_service - 60.0, 0.0) / 60.0
        fault_rate = 0.15 + 0.25 * late_service + 0.35 * sum(np.minimum(r, 2.0) for r in risk.values()) / 3.0 + 0.08 * age / 5.0 + 0.30 * np.maximum(frailty, 0.0)
        this_month = rng.poisson(fault_rate)
        faults = np.minimum(fault_history[0] + fault_history[1] + this_month, spec["num_fault_reports"]["max"])

        fuel_variance = (
            fuel_bias
            + 1.5 * np.maximum(days_since_service - 90.0, 0.0) / 30.0
            + 3.0 * (late["air_filter"] + late["fuel_filter"])
            + 2.0 * np.maximum(frailty, 0.0)
            + rng.normal(0.0, 2.5, vehicles)
        )
        # Too little driving to judge consumption: the core reports 0.
        fuel_variance = np.where(mileage < 100.0, 0.0, fuel_variance)
        fuel_variance = np.clip(fuel_variance, spec["fuel_variance_pct"]["min"], spec["fuel_variance_pct"]["max"])

        dss = np.minimum(days_since_service, spec["days_since_last_service"]["max"])
        p = _sigmoid(failure_logit(dss, faults, age, mileage, fuel_variance, frailty, risk))
        failed = rng.random(vehicles) < p
        component = np.where(failed, _components(rng, mileage, age, fuel_variance, risk), "none")

        row = {
            "vehicle_id": [f"SYN-{i + 1:04d}" for i in range(vehicles)],
            "as_of": as_of[max(m, 0)],
            "mileage_km": np.round(mileage, 1),
            "engine_hours": np.round(engine_hours, 1),
            "days_since_last_service": dss.astype(int),
            "num_fault_reports": faults.astype(int),
            "fuel_variance_pct": np.round(fuel_variance, 1),
            "age_years": np.round(np.clip(age, 0.0, spec["age_years"]["max"]), 1),
        }
        for item in ITEMS:
            for name, unit in item.features:
                value = km_since[item.name] if unit == "km" else days_since[item.name]
                value = np.clip(value, 0.0, spec[name]["max"])
                row[name] = np.round(value, 1) if unit == "km" else value.astype(int)
        row["failure_within_30_days"] = failed.astype(int)
        row["failure_component"] = component
        if m >= 0:
            frames.append(pd.DataFrame(row))

        # The next month. A service is due once the clock passes the vehicle's interval (give or take), or the
        # oil is due; it changes the oil, and the air and fuel filters when they are past 60% of due.
        oil = next(i for i in ITEMS if i.name == "engine_oil")
        oil_due = (km_since["engine_oil"] + mileage >= oil.due_km * care["engine_oil"]) | (days_since["engine_oil"] + 30.0 >= oil.due_days * care["engine_oil"])
        serviced = (days_since_service + 30.0 >= interval * rng.uniform(0.8, 1.3, vehicles)) | oil_due
        renewed = {item.name: np.zeros(vehicles, dtype=bool) for item in ITEMS}
        renewed["engine_oil"] |= serviced
        for name in ("air_filter", "fuel_filter"):
            item = next(i for i in ITEMS if i.name == name)
            renewed[name] |= serviced & (km_since[name] >= 0.6 * item.due_km)
        # Other items are changed when their owner gets round to them: past due, by the vehicle's own habit.
        for item in ITEMS:
            if item.name == "engine_oil":
                continue
            when = rng.uniform(0.85, 1.15, vehicles) * care[item.name]
            km_late = (km_since[item.name] + mileage >= item.due_km * when) if item.due_km else np.zeros(vehicles, dtype=bool)
            days_late = (days_since[item.name] + 30.0 >= item.due_days * when) if item.due_days else np.zeros(vehicles, dtype=bool)
            renewed[item.name] |= km_late | days_late
        # A breakdown is repaired: the failed component's parts are renewed.
        for c, names in RENEWED_ON_FAILURE.items():
            for name in names:
                renewed[name] |= component == c
        done_at = rng.uniform(0.0, 1.0, vehicles)  # how far into the month the change happened
        for item in ITEMS:
            km_since[item.name] = np.where(renewed[item.name], mileage * (1.0 - done_at), km_since[item.name] + mileage)
            days_since[item.name] = np.where(renewed[item.name], np.floor(30.0 * (1.0 - done_at)), days_since[item.name] + 30.0)

        days_since_service = np.where(serviced, rng.integers(0, 30, vehicles), days_since_service + 30.0)
        fault_history = [fault_history[1], np.where(failed, 0, this_month)]
        fault_history[0] = np.where(failed, 0, fault_history[0])

    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values(["vehicle_id", "as_of"], kind="mergesort").reset_index(drop=True)
    return df[columns()]


def to_csv(df: pd.DataFrame, path) -> None:
    """Fixed formatting and line endings, so the same rows are the same bytes on every platform."""
    df.to_csv(path, index=False, lineterminator="\n", float_format="%.1f")
