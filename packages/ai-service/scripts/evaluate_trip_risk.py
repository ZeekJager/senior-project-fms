"""
Grades a trained trip risk model (FMS-155) again, from its folder and the data it was trained on.

    python scripts/evaluate_trip_risk.py models/tr-2026.11 --data data/trip_risk_generated.csv

Exits 1 if the folder, the data or the held-out drivers are not what training recorded, or the metrics differ.
Prints whether the model beats the rules; that decides activation, not this exit code.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ml import artefact  # noqa: E402
from ml.trip_risk.model import evaluate, split  # noqa: E402
from ml.trip_risk.serving import load  # noqa: E402
from ml.trip_risk.spec import LABELS  # noqa: E402
from train_trip_risk import read_data  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "trip_risk_generated.csv")
    args = parser.parse_args(argv)
    try:
        models, metadata = load(args.folder)
        _, recorded = artefact.read(args.folder)
    except artefact.ArtefactError as e:
        print(e, file=sys.stderr)
        return 1
    trained_on = metadata["training_data"]
    if artefact.sha256(args.data) != trained_on["sha256"]:
        print(f"{args.data} is not the data {metadata['model_version']} was trained on ({trained_on['file']})", file=sys.stderr)
        return 1
    train, test = split(read_data(args.data))
    if sorted(test["driver_id"].unique().tolist()) != trained_on["test_drivers"]:
        print("the held-out drivers differ from the ones training recorded", file=sys.stderr)
        return 1
    metrics = evaluate(models, test, train)
    metrics["artefact_mb"] = round((args.folder / artefact.MODEL_FILE).stat().st_size / 1e6, 1)

    kind = " (demonstration)" if metadata.get("demonstration") else ""
    print(f"{metadata['model_version']}{kind} on {metrics['test']['rows']} trips of {metrics['test']['drivers']} drivers it has not seen")
    for label in LABELS:
        m, r = metrics[label]["model"], metrics[label]["rules"]
        print(f"  {label}: ROC-AUC {m['roc_auc']} (rules {r['roc_auc']}), Brier {m['brier']} (rules {r['brier']})")
        for d in metrics[label]["by_depot"]:
            if d["graded"]:
                print(f"    {d['depot_id']}: ROC-AUC {d['model']['roc_auc']} (rules {d['rules']['roc_auc']}) on {d['rows']} trips")
    print("  beats the rules" if metrics["decision"]["beats_rules"] else "  does not beat the rules: " + "; ".join(metrics["decision"]["why"]))
    if metrics != recorded:
        print(f"FAIL: metrics differ from {artefact.METRICS_FILE} recorded at training", file=sys.stderr)
        return 1
    print("PASS: the recorded metrics reproduce")
    return 0


if __name__ == "__main__":
    sys.exit(main())
