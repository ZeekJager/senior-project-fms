"""Data quality checks on a training dataset (FMS-52): the shape, ranges and balance feature_spec.json promises."""

from __future__ import annotations

import pandas as pd

from .spec import columns, component_name, load_spec, target_name

POSITIVE_RATE = (0.15, 0.25)


def problems(df: pd.DataFrame, rows: int | None = None, months: int | None = None) -> list[str]:
    """Everything wrong with the dataset, one line each; an empty list when it is fit to train on."""
    spec = load_spec()
    found: list[str] = []

    if list(df.columns) != columns():
        return [f"columns are {list(df.columns)}, expected {columns()}"]
    if rows is not None and len(df) != rows:
        found.append(f"{len(df)} rows, expected {rows}")
    nulls = df.isna().sum()
    for name, n in nulls[nulls > 0].items():
        found.append(f"{name}: {n} nulls")
    if found:
        return found

    for f in spec["features"]:
        col = df[f["name"]]
        if not pd.api.types.is_numeric_dtype(col):
            found.append(f"{f['name']}: not numeric")
            continue
        if f["type"] == "int" and not (col == col.round()).all():
            found.append(f"{f['name']}: not whole numbers")
        low, high = col.min(), col.max()
        if low < f["min"] or high > f["max"]:
            found.append(f"{f['name']}: range [{low}, {high}] outside [{f['min']}, {f['max']}]")
        if (col.round(f["decimals"]) != col).any():
            found.append(f"{f['name']}: more than {f['decimals']} decimals")

    target, component = df[target_name()], df[component_name()]
    if not target.isin(spec["target"]["values"]).all():
        found.append(f"{target_name()}: values other than {spec['target']['values']}")
    rate = target.mean()
    if not POSITIVE_RATE[0] <= rate <= POSITIVE_RATE[1]:
        found.append(f"{target_name()}: positive rate {rate:.3f} outside {POSITIVE_RATE}")
    if not component.isin(spec["component"]["values"]).all():
        found.append(f"{component_name()}: values outside the FMS-125 catalogue")
    if ((target == 1) != (component != "none")).any():
        found.append(f"{component_name()}: must be none exactly when {target_name()} is 0")

    if df.duplicated(["vehicle_id", "as_of"]).any():
        found.append("a vehicle has two rows for one as_of")
    per_vehicle = df.groupby("vehicle_id")["as_of"]
    if months is not None and (per_vehicle.size() != months).any():
        found.append(f"a vehicle does not have exactly {months} rows")
    dates = pd.to_datetime(df["as_of"], format="%Y-%m-%d", errors="coerce")
    if dates.isna().any():
        found.append("as_of: not a YYYY-MM-DD date")
    else:
        step = dates.groupby(df["vehicle_id"]).apply(lambda d: d.sort_values().dt.to_period("M").astype("int64").diff().dropna())
        if not (step == 1).all():
            found.append("as_of: a vehicle's months are not consecutive")
    return found
