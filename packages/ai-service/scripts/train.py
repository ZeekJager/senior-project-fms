"""
Trains the predictive maintenance model (FMS-53) and writes its folder.

    python scripts/generate_training_data.py         # data/training_data.csv first
    python scripts/train.py                          # models/pm-<this year.month>/
    python scripts/train.py --version pm-2026.10.2 --data /tmp/other.csv

Holds one vehicle in five out of training and grades the model on them.
Exits 1, writing nothing, if the data fails its checks or the model misses
an acceptance criterion.
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
from ml.checks import problems  # noqa: E402
from ml.model import FOLDS, FOREST, MODEL_NAME, SPLIT_SEED, evaluate, fit, gates, importances, split  # noqa: E402
from ml.spec import feature_names, load_spec, spec_hash, target_name  # noqa: E402


def read_data(path: Path) -> pd.DataFrame:
    if not path.is_file():
        raise SystemExit(f"{path} not found: run scripts/generate_training_data.py first")
    return pd.read_csv(path)


def training_data(path: Path, df: pd.DataFrame, train: pd.DataFrame, test: pd.DataFrame) -> dict:
    """What the registry records about the data (FMS-127): which file, how much, which dates, which vehicles were held out."""
    return {
        "file": path.name,
        "sha256": artefact.sha256(path),
        "rows": len(df),
        "vehicles": int(df["vehicle_id"].nunique()),
        "from": str(df["as_of"].min()),
        "to": str(df["as_of"].max()),
        "positive_rate": round(float(df[target_name()].mean()), 4),
        "split": f"{FOLDS}-fold StratifiedGroupKFold by vehicle_id, seed {SPLIT_SEED}, first fold held out",
        "train_rows": len(train),
        "test_rows": len(test),
        "test_vehicles": sorted(test["vehicle_id"].unique().tolist()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "training_data.csv")
    parser.add_argument("--version", default=f"pm-{datetime.now(timezone.utc):%Y.%m}")
    parser.add_argument("--out", type=Path, default=ROOT / "models")
    args = parser.parse_args(argv)
    if not artefact.VERSION.match(args.version):
        print(f"--version {args.version!r} is not like pm-2026.10 (or pm-2026.10.2)", file=sys.stderr)
        return 2
    folder = args.out / args.version
    if folder.exists():
        print(f"{folder} already exists; a version names one model: pass another --version", file=sys.stderr)
        return 1

    started = time.perf_counter()
    df = read_data(args.data)
    found = problems(df)
    if found:
        print(f"{args.data} failed its checks; nothing trained:", *found, sep="\n  ", file=sys.stderr)
        return 1
    train, test = split(df)
    model = fit(train)
    metrics = evaluate(model, test, reference=train)

    with tempfile.TemporaryDirectory() as tmp:
        joblib.dump(model, Path(tmp) / artefact.MODEL_FILE, compress=3)
        size_mb = (Path(tmp) / artefact.MODEL_FILE).stat().st_size / 1e6
    metrics["artefact_mb"] = round(size_mb, 1)
    missed = gates(metrics, size_mb)
    if missed:
        print(f"{args.version} misses its acceptance criteria; nothing written:", *missed, sep="\n  ", file=sys.stderr)
        return 1

    metadata = {
        "name": MODEL_NAME,
        "model_version": args.version,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "RandomForestClassifier with isotonic calibration (CalibratedClassifierCV, ensemble=False)",
        "hyperparameters": {**FOREST, "calibration": "isotonic", "calibration_folds": FOLDS},
        "features": feature_names(),
        "target": target_name(),
        "health_score": "round((1 - p) * 100), p the probability of an unplanned failure in the next 30 days",
        # The training rows' typical inputs: the service (FMS-54) explains a prediction by which inputs, put back to these, lower its risk most.
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
    importance = importances(model, test)
    artefact.save(folder, model, metadata, metrics, importance)

    alert = metrics["at_alert_threshold"]
    print(f"{args.version}: trained on {len(train)} rows, graded on {len(test)} rows of {metrics['test']['vehicles']} unseen vehicles, in {time.perf_counter() - started:.0f} s -> {folder}")
    print(f"ROC-AUC {metrics['roc_auc']:.3f}; riskiest tenth {metrics['riskiest_tenth_fail_share']:.0%} fail, safest half {metrics['safest_half_fail_share']:.0%}")
    print(f"below health {alert['health_score_below']}: {alert['flagged_share']:.0%} of vehicles, precision {alert['precision']:.2f}, recall {alert['recall']:.2f}, F1 {alert['f1']:.2f}")
    print(f"examples: high risk {metrics['examples']['high_risk']['health_score']}, healthy {metrics['examples']['healthy']['health_score']}; {size_mb:.1f} MB")
    print("strongest inputs: " + ", ".join(importance["feature"].head(5)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
