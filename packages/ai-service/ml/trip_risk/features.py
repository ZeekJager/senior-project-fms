"""
The trip risk inputs of one driver on one trip (trip_risk_spec.json), from what was known at t, the trip's scheduled start.

The core computes them in TypeScript (tripRiskFeatures, maintenance/domain/trip-risk.ts) for training and for the dispatch
console; this is the same formula, for the generated dataset. tests/fixtures/trip_risk_features.json holds cases both sides
must agree on, to the decimal.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ml.trip_risk.spec import load_spec

HOUR = timedelta(hours=1)
WINDOW = timedelta(days=90)
# A trip is never planned longer than this, so history before t - WINDOW - LONGEST cannot reach the window.
LONGEST = timedelta(hours=72)
ADDIS = timezone(timedelta(hours=3))
# The core's job load rules (trip/domain/job-load.ts, FMS-153): [at least, points], the higher rung first.
JOB_LOAD_RULES = {
    "distance": ((300, 2), (100, 1)),
    "duration_h": ((9, 2), (4, 1)),
    "stops": ((6, 1),),
    "night_h": ((2, 1),),
    "payload": ((0.9, 2), (0.6, 1)),
}
STANDARD_FROM, HEAVY_FROM = 1, 3
# The core's record features count a driver's trips from this many on (fewer: the depot's typical rate stands in, in the rules).
NIGHT_START_UTC_HOUR, NIGHT_HOURS = 19, 8


@dataclass(frozen=True)
class Job:
    """The trip being judged, as known before it starts."""

    scheduled_start: datetime
    scheduled_end: datetime | None
    planned_distance_km: float | None
    planned_duration_seconds: int | None
    stops: int
    cargo_weight_kg: float | None
    cargo_kind: str
    payload_capacity_kg: float | None


@dataclass(frozen=True)
class Past:
    """A trip of the driver's or the route's: when it ran, and how it went."""

    scheduled_end: datetime | None
    actual_start: datetime
    actual_end: datetime | None
    late: bool | None
    safety_event: bool
    job_load_points: int


def night_hours(start: datetime, end: datetime) -> float:
    """Hours of [start, end] between 22:00 and 06:00 in Addis Ababa (nightHours, FMS-153)."""
    if not end > start:
        return 0.0
    day = timedelta(days=1)
    first = start.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=NIGHT_START_UTC_HOUR)
    if first > start:
        first -= day
    total = timedelta()
    night = first
    while night < end:
        total += max(timedelta(), min(end, night + timedelta(hours=NIGHT_HOURS)) - max(start, night))
        night += day
    return total / HOUR


def _rung(value: float | None, rungs) -> int:
    if value is None:
        return 0
    for at_least, points in rungs:
        if value >= at_least:
            return points
    return 0


def job_load_points(job: Job) -> int:
    """jobLoad(...).points of trip/domain/job-load.ts."""
    window = (job.scheduled_end - job.scheduled_start).total_seconds() if job.scheduled_end and job.scheduled_end > job.scheduled_start else None
    duration = job.planned_duration_seconds if job.planned_duration_seconds is not None else window
    share = job.cargo_weight_kg / job.payload_capacity_kg if job.cargo_weight_kg is not None and job.payload_capacity_kg else None
    return (
        _rung(job.planned_distance_km, JOB_LOAD_RULES["distance"])
        + _rung(None if duration is None else duration / 3600, JOB_LOAD_RULES["duration_h"])
        + _rung(job.stops, JOB_LOAD_RULES["stops"])
        + _rung(night_hours(job.scheduled_start, job.scheduled_end) if job.scheduled_end else None, JOB_LOAD_RULES["night_h"])
        + _rung(share, JOB_LOAD_RULES["payload"])
    )


def load_level(points: int) -> str:
    return "heavy" if points >= HEAVY_FROM else "standard" if points >= STANDARD_FROM else "light"


def round_half_up(value: float, decimals: int) -> float:
    """As the core rounds (Math.round): halves go up, never to even."""
    scale = 10**decimals
    return math.floor(value * scale + 0.5) / scale


def _share(trips: list[Past], hit) -> float:
    judged = [p for p in trips if p.late is not None] if hit == "late" else trips
    if not judged:
        return 0.0
    return sum(1 for p in judged if (p.late if hit == "late" else p.safety_event)) / len(judged)


def _hours_inside(trips: list[Past], start: datetime, end: datetime) -> float:
    total = timedelta()
    for p in trips:
        if p.actual_start >= end:
            continue
        stop = min(p.actual_end or end, end)
        total += max(timedelta(), stop - max(p.actual_start, start))
    return total / HOUR


def finish(raw: dict[str, float]) -> dict[str, float | int]:
    """Capped to the spec's range and rounded to its decimals, in the spec's order."""
    out: dict[str, float | int] = {}
    for f in load_spec()["features"]:
        v = min(max(float(raw[f["name"]]), f["min"]), f["max"])
        out[f["name"]] = int(round_half_up(v, 0)) if f["type"] == "int" else round_half_up(v, f["decimals"])
    return out


def trip_features(job: Job, driver: list[Past], route: list[Past]) -> dict[str, float | int]:
    """
    The inputs for one driver on `job`, at t = job.scheduled_start. `driver` and `route` are trips that started before t
    (any order); trips not yet ended at t count as under way.
    """
    t = job.scheduled_start
    started = [p for p in driver if p.actual_start < t]
    done = [p for p in started if p.actual_end is not None and p.actual_end <= t]
    recent = [p for p in done if p.actual_end >= t - WINDOW]
    points = job_load_points(job)
    same = [p for p in recent if load_level(p.job_load_points) == load_level(points)]
    route_recent = [p for p in route if p.actual_end is not None and t - WINDOW <= p.actual_end < t]
    under_way = any(p.actual_end is None or p.actual_end > t for p in started)
    last_end = max((p.actual_end for p in done), default=None)
    local = t.astimezone(ADDIS)
    share = (
        min(job.cargo_weight_kg / job.payload_capacity_kg, 1.0)
        if job.cargo_weight_kg is not None and job.payload_capacity_kg
        else 0.0
    )
    duration = (
        job.planned_duration_seconds / 3600
        if job.planned_duration_seconds is not None
        else (job.scheduled_end - t) / HOUR if job.scheduled_end and job.scheduled_end > t else 0.0
    )
    return finish({
        "driver_trips_90d": len(recent),
        "driver_late_share_90d": _share(recent, "late"),
        "driver_safety_share_90d": _share(recent, "safety"),
        "driver_same_load_trips_90d": len(same),
        "driver_same_load_late_share_90d": _share(same, "late"),
        "job_load_points": points,
        "planned_distance_km": job.planned_distance_km or 0.0,
        "planned_duration_h": duration,
        "stops": job.stops,
        "night_hours": night_hours(t, job.scheduled_end) if job.scheduled_end else 0.0,
        "cargo_share": share,
        "cargo_hazardous": job.cargo_kind == "hazardous",
        "cargo_fragile": job.cargo_kind == "fragile",
        "cargo_refrigerated": job.cargo_kind == "refrigerated",
        "cargo_passengers": job.cargo_kind == "passengers",
        "start_hour": local.hour,
        "weekday": local.weekday(),
        "hours_since_last_trip": 0.0 if under_way else (t - last_end) / HOUR if last_end else 336.0,
        "hours_driven_24h": _hours_inside(started, t - timedelta(hours=24), t),
        "hours_driven_7d": _hours_inside(started, t - timedelta(days=7), t),
        "route_trips_90d": len(route_recent),
        "route_late_share_90d": _share(route_recent, "late"),
    })
