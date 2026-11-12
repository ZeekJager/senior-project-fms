"""
The trip risk datasets (FMS-155): their checks, the least data a model is trained on, and a generated dataset for a
demonstration while the fleet has too few real trips (docs/ml-trip-risk.md).

A real dataset is exported by the core (npm run ml:trip-risk-dataset), source `fleet`. The generated one simulates
60 drivers of 4 depots over 210 days, trip by trip in time order, so each trip's inputs come from the history before it
exactly as the core computes them (ml/trip_risk/features.py). Its outcomes follow a known rule: the driver's own habits,
fatigue, the night, the job's load and the route raise both risks, so a model has something real to learn, and the
driver's past rates alone (the rules it must beat) miss the fatigue and the job. Source `generated`; a model trained on
it is a demonstration, and says so everywhere it shows.
"""

from __future__ import annotations

import bisect
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ml.trip_risk.features import LONGEST, WINDOW, Job, Past, job_load_points, trip_features
from ml.trip_risk.spec import LABELS, SOURCES, columns, feature_names, id_columns, load_spec, minimum

SEED = 155
START = datetime(2026, 1, 5, tzinfo=timezone.utc)
DAYS = 210
DEPOTS = 4
DRIVERS_PER_DEPOT = 15
ROUTES_PER_DEPOT = 8
# Each depot's late margin (trip_delay_minutes, FMS-147).
MARGINS = (15, 15, 20, 15)
# Either label's share of positives must be in this range: a model needs both outcomes to learn from.
POSITIVE_RATE = (0.02, 0.6)


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def generate(seed: int = SEED) -> pd.DataFrame:
    """The demonstration dataset: about 12,000 trips, the same rows for the same seed."""
    rng = np.random.default_rng(seed)
    routes = []
    for d in range(DEPOTS):
        for r in range(ROUTES_PER_DEPOT):
            km = float(np.clip(rng.lognormal(math.log(120), 0.8), 15, 900))
            stops = int(rng.integers(0, 4) if km < 80 else rng.integers(0, 9))
            routes.append({
                "id": f"GEN-R{d}{r}", "depot": d, "km": round(km, 1), "stops": stops,
                "hours": km / 50 + stops * 0.3 + 0.3, "difficulty": float(rng.normal(0, 0.35)),
                "kind": rng.choice(["general", "fragile", "hazardous", "refrigerated", "passengers"], p=[0.55, 0.15, 0.1, 0.1, 0.1]),
            })
    drivers = [
        {"id": f"GEN-D{d * DRIVERS_PER_DEPOT + i + 1:03d}", "depot": d, "late": float(rng.normal(0, 0.55)), "safety": float(rng.normal(0, 0.6)),
         "night_shift": bool(rng.random() < 0.2), "hard_worker": bool(rng.random() < 0.25)}
        for d in range(DEPOTS) for i in range(DRIVERS_PER_DEPOT)
    ]

    # The schedule first: it is planned ahead and does not depend on how the trips went.
    planned = []
    for drv in drivers:
        own = [r for r in routes if r["depot"] == drv["depot"]]
        for day in range(DAYS):
            if rng.random() > (0.85 if drv["hard_worker"] else 0.7):
                continue
            hour = rng.uniform(19, 23) if drv["night_shift"] and rng.random() < 0.6 else rng.uniform(5, 10)
            at = START + timedelta(days=day, hours=float(hour) - 3)
            for _ in range(1 + int(rng.random() < (0.45 if drv["hard_worker"] else 0.2))):
                route = own[int(rng.integers(len(own)))]
                hours = route["hours"] * float(rng.uniform(0.9, 1.15))
                end = at + timedelta(hours=hours)
                payload = float(rng.choice([1000, 3500, 8000, 25000]))
                weight = round(payload * float(rng.uniform(0.2, 1.0)), 2) if route["kind"] != "passengers" and rng.random() < 0.8 else None
                planned.append({"driver": drv, "route": route, "start": at, "end": end, "payload": payload, "weight": weight})
                at = end + timedelta(hours=float(rng.uniform(0.5, 2.5)))
    planned.sort(key=lambda p: (p["start"], p["driver"]["id"]))

    # Then the trips in time order: each one's inputs from what happened before it, then how it went.
    history: dict[str, list[tuple[datetime, Past]]] = defaultdict(list)
    route_history: dict[str, list[tuple[datetime, Past]]] = defaultdict(list)
    rows = []
    for n, p in enumerate(planned):
        drv, route = p["driver"], p["route"]
        job = Job(p["start"], p["end"], route["km"], int((p["end"] - p["start"]).total_seconds()), route["stops"], p["weight"], str(route["kind"]), p["payload"])
        t = job.scheduled_start
        since = t - WINDOW - LONGEST
        f = trip_features(job, _since(history[drv["id"]], since), _since(route_history[route["id"]], since))

        tired = (f["hours_driven_24h"] > 10) + (f["hours_since_last_trip"] < 8)
        night = f["night_hours"] >= 2
        late_p = _logistic(-2.3 + drv["late"] + 0.28 * f["job_load_points"] + 0.75 * tired + 0.35 * night + route["difficulty"] + 0.45 * (f["cargo_share"] > 0.9))
        safety_p = _logistic(-3.1 + drv["safety"] + 0.7 * night + 0.6 * tired + 0.5 * f["cargo_hazardous"] + 0.0015 * route["km"])
        late = bool(rng.random() < late_p)
        safety = bool(rng.random() < safety_p)
        margin = MARGINS[drv["depot"]]
        actual_start = t + timedelta(minutes=float(rng.uniform(-5, 10)))
        actual_end = job.scheduled_end + timedelta(minutes=margin + 1 + float(rng.exponential(35)) if late else float(rng.uniform(-25, margin - 1)))
        past = Past(job.scheduled_end, actual_start, actual_end, late, safety, job_load_points(job))
        history[drv["id"]].append((t, past))
        route_history[route["id"]].append((t, past))
        rows.append({
            "trip_id": f"GEN-T{n + 1:06d}", "driver_id": drv["id"], "depot_id": f"GEN-DEPOT-{drv['depot'] + 1}",
            "as_of": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "generated", **f, "late": int(late), "safety_event": int(safety),
        })
    return pd.DataFrame(rows, columns=columns())


def _since(trips: list[tuple[datetime, Past]], since: datetime) -> list[Past]:
    """The trips scheduled from `since` on (the list is in schedule order)."""
    i = bisect.bisect_left([s for s, _ in trips], since)
    return [p for _, p in trips[i:]]


def to_csv(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, lineterminator="\n")


def problems(df: pd.DataFrame) -> list[str]:
    """Everything wrong with the dataset, one line each; an empty list when it is fit to train on."""
    if list(df.columns) != columns():
        return [f"columns are {list(df.columns)}, expected {columns()}"]
    found: list[str] = []
    nulls = df[[*feature_names(), *LABELS]].isna().sum()
    for name, n in nulls[nulls > 0].items():
        found.append(f"{name}: {n} nulls")
    for name in id_columns():
        if df[name].isna().any() or (df[name].astype(str).str.strip() == "").any():
            found.append(f"{name}: blank values")
    if found:
        return found
    for f in load_spec()["features"]:
        col = df[f["name"]]
        if not pd.api.types.is_numeric_dtype(col):
            found.append(f"{f['name']}: not numeric")
            continue
        if f["type"] == "int" and not (col == col.round()).all():
            found.append(f"{f['name']}: not whole numbers")
        if col.min() < f["min"] or col.max() > f["max"]:
            found.append(f"{f['name']}: range [{col.min()}, {col.max()}] outside [{f['min']}, {f['max']}]")
        if (col.round(f["decimals"]) != col).any():
            found.append(f"{f['name']}: more than {f['decimals']} decimals")
    for label in LABELS:
        if not df[label].isin([0, 1]).all():
            found.append(f"{label}: values other than 0 and 1")
        elif not POSITIVE_RATE[0] <= df[label].mean() <= POSITIVE_RATE[1]:
            found.append(f"{label}: positive rate {df[label].mean():.3f} outside {POSITIVE_RATE}")
    sources = set(df["source"].unique())
    if not sources <= set(SOURCES):
        found.append(f"source: values other than {SOURCES}")
    elif len(sources) > 1:
        found.append("source: fleet and generated rows are mixed; train on one or the other")
    if df.duplicated(["trip_id", "driver_id"]).any():
        found.append("a trip has two rows for one driver")
    if pd.to_datetime(df["as_of"], format="%Y-%m-%dT%H:%M:%SZ", errors="coerce").isna().any():
        found.append("as_of: not a UTC time like 2026-01-05T05:00:00Z")
    return found


def shortfall(df: pd.DataFrame) -> str | None:
    """Why there is too little data to train on (the spec's minimum), or None. The console then says "Not enough trips yet"."""
    need = minimum()
    trips, drivers = len(df), int(df["driver_id"].nunique()) if len(df) else 0
    if trips >= need["trips"] and drivers >= need["drivers"]:
        return None
    return f"not enough trips yet: {trips:,} trips of {drivers} drivers; needs {need['trips']:,} trips across {need['drivers']} drivers"


def is_demonstration(df: pd.DataFrame) -> bool:
    return bool(len(df) and (df["source"] == "generated").all())
