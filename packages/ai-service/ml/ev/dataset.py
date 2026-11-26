"""
The synthetic EV training dataset (FMS-134): 500 electric vehicles, each scored on the first day of 24 consecutive
months, in the columns of feature_spec_ev.json.

There is no real EV history, so, as for combustion vehicles (ml.dataset), the rows come from a small simulation, not
from rules on the inputs. Each EV has fixed traits: its model (a car, a van, a bus or a truck, with its own energy per
km), how hard and how far it is driven, how hot its routes run, how much it fast-charges, how deep it lets the pack
run, how reliable its charging is, how well its few wearing parts are kept up, and a hidden frailty the model never
sees. Month by month:

- the traction pack ages: a little with time, more with cycles (distance), heat, DC fast charging and deep
  discharges, at the vehicle's own rate;
- the pack heats on hot routes and when fast-charging; a worn pack runs warmer and uses more energy per km;
- charging sessions fail now and then, more on a vehicle whose charging system is weak;
- the brake pads wear slowly (regenerative braking does most of the stopping), the tyres faster (EVs are heavy),
  the coolant of the thermal loop, the brake fluid and the 12 V battery age by time;
- it breaks down or not, with a probability that rises with a degraded or fast-degrading pack, heat, failed
  charging, deep discharges, overdue parts, overdue service and reported faults, and the component that fails
  follows the cause most of the time. A breakdown is repaired: a failed traction battery gets modules replaced and
  recovers health; a failed thermal loop gets new coolant; a failed charging system stops failing for a while.

So the label depends on the inputs, but not only on them, and a model trained on it has to generalise rather than
recover a formula. Every draw comes from one seeded generator (numpy PCG64) in a fixed order, so the same seed gives
the same bytes on every run.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from ml.dataset import _months, _sigmoid, to_csv  # noqa: F401  (to_csv: the same fixed formatting)

from .spec import columns, load_spec

SEED = 134
VEHICLES = 500
MONTHS = 24
FIRST_MONTH = date(2024, 10, 1)
WARM_UP_MONTHS = 12

# Components an EV fails in, from the FMS-125 catalogue with FMS-134's EV components.
COMPONENTS = ["traction_battery", "motor_inverter", "charging_system", "thermal_management", "brakes", "tyres", "electrical", "suspension", "steering", "body", "other"]

# The EV models of the catalogue (as scripts/simulator/ev-charging.ts's profiles): a car, a van, a bus, a truck.
PROFILES = [
    # name, share, expected Wh/km, monthly km (median)
    ("car", 0.30, 160.0, 2500.0),
    ("van", 0.35, 250.0, 3000.0),
    ("bus", 0.20, 1000.0, 4200.0),
    ("truck", 0.15, 1200.0, 3600.0),
]


@dataclass(frozen=True)
class Item:
    """A wearing part or fluid an EV has (maintenance.service_item): when it is due, and what it protects."""

    name: str
    due_km: float | None
    due_days: float | None
    protects: tuple[str, ...]
    features: tuple[tuple[str, str], ...]


# EV intervals: pads last twice as long (regenerative braking), tyres less (weight); the thermal loop's coolant
# four years; battery is the 12 V auxiliary.
ITEMS = [
    Item("coolant", None, 1_460, ("thermal_management",), (("days_since_coolant_change", "days"),)),
    Item("brake_pads", 90_000, None, ("brakes",), (("km_since_brake_pad_change", "km"),)),
    Item("brake_fluid", None, 730, ("brakes",), (("days_since_brake_fluid_change", "days"),)),
    Item("tyres", 60_000, 2_000, ("tyres",), (("km_since_tyre_change", "km"), ("days_since_tyre_change", "days"))),
    Item("battery", None, 1_460, ("electrical",), (("days_since_battery_change", "days"),)),
]

RENEWED_ON_FAILURE = {
    "thermal_management": ("coolant",),
    "brakes": ("brake_pads", "brake_fluid"),
    "tyres": ("tyres",),
    "electrical": ("battery",),
}


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


def pack_risk(health, drop, hot_hours, deep, failed_sessions) -> dict[str, np.ndarray]:
    """The EV components' own risk, before the parts: a worn or fast-wearing pack, heat, deep discharges, failed charging."""
    degraded = np.clip((88.0 - health) / 6.0, 0.0, 3.0)
    wearing = np.clip(drop / 2.0, 0.0, 3.0)
    heat = np.clip(hot_hours / 80.0, 0.0, 3.0)
    return {
        "traction_battery": degraded + wearing + 0.3 * np.minimum(deep, 10) / 5.0,
        "thermal_management": heat,
        "charging_system": np.clip(failed_sessions / 3.0, 0.0, 3.0),
        "motor_inverter": 0.5 * heat,
    }


def failure_logit(days_since_service, faults, age, mileage, frailty, risk, parts_late) -> np.ndarray:
    """
    Log-odds of an unplanned failure in the next 30 days. A degraded, fast-degrading or hot pack and failed charging
    weigh most; overdue parts, overdue service and reported faults follow; age and hard use add theirs. The frailty
    term is not in the dataset.
    """
    late_service = np.clip((days_since_service - 90.0) / 45.0, -2.0, 6.0)
    ev = sum(np.minimum(r, 3.0) for r in risk.values())
    return (
        -5.35
        + 1.25 * np.minimum(ev, 6.0)
        + 1.60 * np.minimum(parts_late, 3.0)
        + 0.35 * late_service
        + 0.40 * np.minimum(faults, 8)
        + 0.08 * age
        + 0.10 * mileage / 1000.0
        + 1.80 * ((risk["traction_battery"] > 1.5) & (risk["thermal_management"] > 1.0))
        + frailty
    )


def _components(rng: np.random.Generator, mileage, age, risk, late) -> np.ndarray:
    """Which component failed: mostly the one its cause points to; otherwise wear parts follow distance."""
    part_risk = {c: np.zeros_like(age) for c in COMPONENTS}
    for item in ITEMS:
        for c in item.protects:
            part_risk[c] = part_risk[c] + late[item.name]
    base = {
        "traction_battery": np.full_like(age, 0.6),
        "motor_inverter": 0.3 + age / 10.0,
        "charging_system": np.full_like(age, 0.5),
        "thermal_management": np.full_like(age, 0.4),
        "brakes": 0.5 + mileage / 6000.0,
        "tyres": 0.8 + mileage / 4000.0,
        "electrical": np.full_like(age, 0.6),
        "suspension": 0.5 + mileage / 5000.0,
        "steering": np.full_like(age, 0.2),
        "body": np.full_like(age, 0.2),
        "other": np.full_like(age, 0.2),
    }
    weights = np.stack([base[c] * np.exp(1.8 * np.minimum(risk.get(c, 0.0) + part_risk[c], 3.0)) for c in COMPONENTS], axis=1)
    cumulative = np.cumsum(weights / weights.sum(axis=1, keepdims=True), axis=1)
    roll = rng.random(len(age))[:, None]
    return np.asarray(COMPONENTS)[np.minimum((roll > cumulative).sum(axis=1), len(COMPONENTS) - 1)]


def generate(seed: int = SEED, vehicles: int = VEHICLES, months: int = MONTHS, first_month: date = FIRST_MONTH) -> pd.DataFrame:
    """The dataset as a DataFrame in feature_spec_ev.json's column order, by vehicle, then month."""
    rng = np.random.default_rng(seed)
    spec = {f["name"]: f for f in load_spec()["features"]}

    # Fixed traits.
    kind = rng.choice(len(PROFILES), size=vehicles, p=[p[1] for p in PROFILES])
    expected_wh = np.array([p[2] for p in PROFILES])[kind]
    usage = np.clip(np.array([p[3] for p in PROFILES])[kind] * rng.lognormal(0.0, 0.4, vehicles), 300.0, 12000.0)
    age0 = rng.uniform(0.3, 7.0, vehicles)
    hot_routes = rng.lognormal(np.log(25.0), 0.7, vehicles)  # hours a month the pack runs hot, before fast charging
    fast_habit = rng.beta(1.5, 3.0, vehicles)  # share of energy taken at DC fast chargers
    deep_habit = rng.lognormal(np.log(0.8), 0.9, vehicles)  # deep discharges a month
    weak_charging = rng.lognormal(np.log(0.25), 0.9, vehicles)  # failed sessions a month
    ageing = rng.lognormal(0.0, 0.35, vehicles)  # the pack's own rate of wear
    interval = rng.uniform(60.0, 200.0, vehicles)  # days between services
    frailty = rng.normal(0.0, 0.5, vehicles)
    energy_bias = rng.normal(0.0, 4.0, vehicles)
    neglect = rng.lognormal(0.15, 0.4, vehicles)
    care = {item.name: neglect * rng.lognormal(0.0, 0.5, vehicles) for item in ITEMS}

    # State going into the warm-up.
    health = np.clip(100.0 - age0 * rng.uniform(1.0, 2.6, vehicles), 60.0, 100.0)
    health_history = [health.copy(), health.copy(), health.copy()]
    days_since_service = rng.integers(0, 181, vehicles).astype(float)
    fault_history = [rng.poisson(0.15, vehicles), rng.poisson(0.15, vehicles)]
    failed_history = [rng.poisson(weak_charging), rng.poisson(weak_charging)]
    km_since, days_since = {}, {}
    for item in ITEMS:
        start = rng.uniform(0.0, 1.2, vehicles) * care[item.name]
        km_since[item.name] = start * (item.due_km or usage * (item.due_days or 365) / 30.0)
        days_since[item.name] = start * (item.due_days or (item.due_km or 0) / usage * 30.0)
    charging_fixed = np.zeros(vehicles)  # months left of a repaired charging system

    as_of = _months(first_month, months)
    frames = []
    for m in range(-WARM_UP_MONTHS, months):
        idle = rng.random(vehicles) < 0.03
        mileage = np.clip(usage * rng.gamma(8.0, 1.0 / 8.0, vehicles) * np.where(idle, 0.01, 1.0), 0.0, spec["mileage_km"]["max"])
        age = np.maximum(age0 + m / 12.0, 0.0)
        driven = mileage / np.maximum(usage, 1.0)

        fast_share = np.where(idle, 0.0, np.clip(fast_habit + rng.normal(0.0, 0.08, vehicles), 0.0, 1.0))
        worn = np.maximum(92.0 - health, 0.0)
        hot_hours = np.clip(hot_routes * driven * rng.lognormal(0.0, 0.3, vehicles) + 40.0 * fast_share + 2.5 * worn, 0.0, spec["high_temp_hours_30d"]["max"])
        deep = np.minimum(rng.poisson(deep_habit * driven), spec["deep_discharges_30d"]["max"])
        failed_now = rng.poisson(weak_charging * np.where(charging_fixed > 0, 0.2, 1.0) * np.where(idle, 0.1, 1.0))
        failed_sessions = np.minimum(failed_history[0] + failed_history[1] + failed_now, spec["failed_charging_sessions_90d"]["max"])

        drop = np.clip(health_history[0] - health, 0.0, spec["battery_health_drop_90d"]["max"])
        energy_vs = np.where(
            mileage < 100.0,
            0.0,
            energy_bias + 0.9 * worn + 0.04 * hot_hours + 2.5 * overdue(km_since, days_since)["tyres"] + rng.normal(0.0, 3.0, vehicles),
        )
        energy_vs = np.clip(energy_vs, spec["energy_vs_expected_pct"]["min"], spec["energy_vs_expected_pct"]["max"])

        late = overdue(km_since, days_since)
        parts_late = sum(np.minimum(v, 2.0) for v in late.values())
        risk = pack_risk(health, drop, hot_hours, deep, failed_sessions)
        late_service = np.maximum(days_since_service - 90.0, 0.0) / 60.0
        fault_rate = 0.12 + 0.2 * late_service + 0.25 * parts_late / 2.0 + 0.2 * sum(np.minimum(r, 3.0) for r in risk.values()) / 3.0 + 0.25 * np.maximum(frailty, 0.0)
        this_month = rng.poisson(fault_rate)
        faults = np.minimum(fault_history[0] + fault_history[1] + this_month, spec["num_fault_reports"]["max"])

        dss = np.minimum(days_since_service, spec["days_since_last_service"]["max"])
        p = _sigmoid(failure_logit(dss, faults, age, mileage, frailty, risk, parts_late))
        failed = rng.random(vehicles) < p
        component = np.where(failed, _components(rng, mileage, age, risk, late), "none")

        row = {
            "vehicle_id": [f"SYN-EV-{i + 1:04d}" for i in range(vehicles)],
            "as_of": as_of[max(m, 0)],
            "mileage_km": np.round(mileage, 1),
            "days_since_last_service": dss.astype(int),
            "num_fault_reports": faults.astype(int),
            "age_years": np.round(np.clip(age, 0.0, spec["age_years"]["max"]), 1),
        }
        for item in ITEMS:
            for name, unit in item.features:
                value = km_since[item.name] if unit == "km" else days_since[item.name]
                value = np.clip(value, 0.0, spec[name]["max"])
                row[name] = np.round(value, 1) if unit == "km" else value.astype(int)
        row["battery_health_pct"] = np.round(np.clip(health, spec["battery_health_pct"]["min"], 100.0), 1)
        row["battery_health_drop_90d"] = np.round(drop, 1)
        row["high_temp_hours_30d"] = np.round(hot_hours, 1)
        row["energy_vs_expected_pct"] = np.round(energy_vs, 1)
        row["dc_fast_share_pct"] = np.round(100.0 * fast_share, 1)
        row["deep_discharges_30d"] = deep.astype(int)
        row["failed_charging_sessions_90d"] = failed_sessions.astype(int)
        row["failure_within_30_days"] = failed.astype(int)
        row["failure_component"] = component
        if m >= 0:
            frames.append(pd.DataFrame(row))

        # The next month. The pack wears: time, cycles, heat, fast charging, deep discharges, at its own rate.
        wear = ageing * (0.08 + 0.00005 * mileage + 0.003 * hot_hours + 0.25 * fast_share + 0.04 * deep)
        health = health - wear * rng.lognormal(0.0, 0.25, vehicles)
        # A failed traction battery gets modules replaced: most of its health back.
        health = np.where(component == "traction_battery", np.maximum(health, rng.uniform(90.0, 97.0, vehicles)), health)
        health = np.clip(health, 50.0, 100.0)
        health_history = [health_history[1], health_history[2], health.copy()]

        serviced = days_since_service + 30.0 >= interval * rng.uniform(0.8, 1.3, vehicles)
        renewed = {item.name: np.zeros(vehicles, dtype=bool) for item in ITEMS}
        for item in ITEMS:
            when = rng.uniform(0.85, 1.15, vehicles) * care[item.name]
            km_late = (km_since[item.name] + mileage >= item.due_km * when) if item.due_km else np.zeros(vehicles, dtype=bool)
            days_late = (days_since[item.name] + 30.0 >= item.due_days * when) if item.due_days else np.zeros(vehicles, dtype=bool)
            renewed[item.name] |= km_late | days_late
        for c, names in RENEWED_ON_FAILURE.items():
            for name in names:
                renewed[name] |= component == c
        done_at = rng.uniform(0.0, 1.0, vehicles)
        for item in ITEMS:
            km_since[item.name] = np.where(renewed[item.name], mileage * (1.0 - done_at), km_since[item.name] + mileage)
            days_since[item.name] = np.where(renewed[item.name], np.floor(30.0 * (1.0 - done_at)), days_since[item.name] + 30.0)
        days_since_service = np.where(serviced | failed, np.floor(30.0 * (1.0 - done_at)), days_since_service + 30.0)
        charging_fixed = np.where(component == "charging_system", 6.0, np.maximum(charging_fixed - 1.0, 0.0))
        fault_history = [np.where(failed, 0, fault_history[1]), np.where(failed, 0, this_month)]
        failed_history = [failed_history[1], np.where(component == "charging_system", 0, failed_now)]

    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values(["vehicle_id", "as_of"], kind="mergesort").reset_index(drop=True)
    return df[columns()]
