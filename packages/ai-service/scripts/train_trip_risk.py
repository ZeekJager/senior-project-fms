"""
Trains the trip risk model (FMS-155) and writes its folder.

    python scripts/generate_trip_risk_data.py                     # a demonstration dataset, or
    npm run ml:trip-risk-dataset -w fms-backend -- --out trips.csv  # the fleet's own trips
    python scripts/train_trip_risk.py --data trips.csv              # models/tr-<this year.month>/

Holds one driver in five out of training and grades both labels on them, against the rules the console uses without a
model. Exits 1, writing nothing, if the data fails its checks or is below the minimum (2,000 trips across 20 drivers).
A model that does not beat the rules is written all the same, with the reason, so the registry records it; it can never
be activated (docs/ml-trip-risk.md).
"""

from __future__ import annotations

import argparse
import platform
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ml import artefact  # noqa: E402
from ml.trip_risk.dataset import is_demonstration, problems, shortfall  # noqa: E402
from ml.trip_risk.model import BOOSTING, FOLDS, SPLIT_SEED, evaluate, fit, importances, split  # noqa: E402
from ml.trip_risk.serving import VERSION  # noqa: E402
from ml.trip_risk.spec import LABELS, MODEL_NAME, columns, feature_names, load_spec, spec_hash  # noqa: E402

MAX_ARTEFACT_MB = 50


def read_data(path: Path) -> pd.DataFrame:
    if not path.is_file():
        raise SystemExit(f"{path} not found: run scripts/generate_trip_risk_data.py, or export the fleet's trips")
    return pd.read_csv(path, dtype={"trip_id": str, "driver_id": str, "depot_id": str, "as_of": str, "source": str})


def training_data(path: Path, df: pd.DataFrame, train: pd.DataFrame, test: pd.DataFrame) -> dict:
    return {
        "file": path.name,
        "sha256": artefact.sha256(path),
        "source": "generated" if is_demonstration(df) else "fleet",
        "rows": len(df),
        "drivers": int(df["driver_id"].nunique()),
        "depots": int(df["depot_id"].nunique()),
        "from": str(df["as_of"].min()),
        "to": str(df["as_of"].max()),
        "positive_rates": {label: round(float(df[label].mean()), 4) for label in LABELS},
        "split": f"{FOLDS}-fold StratifiedGroupKFold by driver_id on late, seed {SPLIT_SEED}, first fold held out",
        "train_rows": len(train),
        "test_rows": len(test),
        "test_drivers": sorted(test["driver_id"].unique().tolist()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "trip_risk_generated.csv")
    parser.add_argument("--version", default=f"tr-{datetime.now(timezone.utc):%Y.%m}")
    parser.add_argument("--out", type=Path, default=ROOT / "models")
    args = parser.parse_args(argv)
    if not VERSION.match(args.version):
        print(f"--version {args.version!r} is not like tr-2026.11 (or tr-2026.11.2)", file=sys.stderr)
        return 2
    folder = args.out / args.version
    if folder.exists():
        print(f"{folder} already exists; a version names one model: pass another --version", file=sys.stderr)
        return 1

    started = time.perf_counter()
    df = read_data(args.data)
    # Too little data first: an export of a young fleet is short before it is anything else.
    short = shortfall(df) if list(df.columns) == columns() else None
    if short:
        print(f"{args.data}: {short}; nothing trained", file=sys.stderr)
        return 1
    found = problems(df)
    if found:
        print(f"{args.data} failed its checks; nothing trained:", *found, sep="\n  ", file=sys.stderr)
        return 1
    demonstration = is_demonstration(df)
    train, test = split(df)
    models = fit(train)
    metrics = evaluate(models, test, train)

    with tempfile.TemporaryDirectory() as tmp:
        joblib.dump(models, Path(tmp) / artefact.MODEL_FILE, compress=3)
        size_mb = (Path(tmp) / artefact.MODEL_FILE).stat().st_size / 1e6
    metrics["artefact_mb"] = round(size_mb, 1)
    if size_mb >= MAX_ARTEFACT_MB:
        print(f"{args.version}: the model file is {size_mb:.1f} MB, needs under {MAX_ARTEFACT_MB}; nothing written", file=sys.stderr)
        return 1

    metadata = {
        "name": MODEL_NAME,
        "model_version": args.version,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "HistGradientBoostingClassifier per label (late, safety_event) with isotonic calibration (CalibratedClassifierCV, ensemble=False)",
        "hyperparameters": {**BOOSTING, "calibration": "isotonic", "calibration_folds": FOLDS},
        "features": feature_names(),
        "labels": list(LABELS),
        "demonstration": demonstration,
        "feature_medians": {name: float(train[name].median()) for name in feature_names()},
        "feature_spec_version": load_spec()["spec_version"],
        "feature_spec_hash": spec_hash(),
        "training_data": training_data(args.data, df, train, test),
        "libraries": {
            "python": platform.python_version(),
            "scikit-learn": sklearn.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "joblib": joblib.__version__,
        },
    }
    importance = importances(models, test)
    artefact.save(folder, models, metadata, metrics, importance, version=VERSION)

    kind = "a DEMONSTRATION, trained on generated trips" if demonstration else "trained on the fleet's trips"
    print(f"{args.version}: {kind}; {len(train)} trips to train, graded on {len(test)} trips of {metrics['test']['drivers']} unseen drivers, in {time.perf_counter() - started:.0f} s -> {folder}")
    for label in LABELS:
        m, r = metrics[label]["model"], metrics[label]["rules"]
        print(f"{label}: ROC-AUC {m['roc_auc']}, Brier {m['brier']}; the rules {r['roc_auc']}, {r['brier']} ({metrics[label]['positive_rate']:.1%} positive)")
    decision = metrics["decision"]
    print("beats the rules: it may be activated" if decision["beats_rules"] else "does NOT beat the rules: it is recorded, and cannot be activated:\n  " + "\n  ".join(decision["why"]))
    print("strongest inputs: " + ", ".join(importance["feature"].head(5)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
