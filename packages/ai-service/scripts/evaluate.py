"""
Grades a trained model (FMS-53) again, from its folder and the data it was trained on.

    python scripts/evaluate.py models/pm-2026.10
    python scripts/evaluate.py models/pm-2026.10 --data /tmp/other.csv

Prints precision, recall, F1, ROC-AUC and the example vehicles' scores on the
vehicles held out of training. Exits 1 if the folder, the data or the metrics
do not match what training recorded, or the model misses an acceptance criterion.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ml import artefact  # noqa: E402
from ml.model import evaluate, gates, split  # noqa: E402
from train import read_data  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "training_data.csv")
    args = parser.parse_args(argv)

    try:
        model, metadata = artefact.load(args.folder)
        _, recorded = artefact.read(args.folder)
    except artefact.ArtefactError as e:
        print(e, file=sys.stderr)
        return 1
    trained_on = metadata["training_data"]
    if artefact.sha256(args.data) != trained_on["sha256"]:
        print(f"{args.data} is not the data {metadata['model_version']} was trained on ({trained_on['file']}, sha256 {trained_on['sha256']})", file=sys.stderr)
        return 1

    train, test = split(read_data(args.data))
    if sorted(test["vehicle_id"].unique().tolist()) != trained_on["test_vehicles"]:
        print("the held-out vehicles differ from the ones training recorded", file=sys.stderr)
        return 1
    metrics = evaluate(model, test, reference=train)
    metrics["artefact_mb"] = round((args.folder / artefact.MODEL_FILE).stat().st_size / 1e6, 1)

    alert = metrics["at_alert_threshold"]
    print(f"{metadata['model_version']} on {metrics['test']['rows']} rows of {metrics['test']['vehicles']} vehicles it has not seen ({metrics['test']['positive_rate']:.1%} failed)")
    print(f"  ROC-AUC    {metrics['roc_auc']:.3f}")
    print(f"  Brier      {metrics['brier']:.3f}")
    print(f"  below health {alert['health_score_below']}: precision {alert['precision']:.3f}, recall {alert['recall']:.3f}, F1 {alert['f1']:.3f} ({alert['flagged_share']:.0%} of vehicles)")
    print(f"  riskiest tenth: {metrics['riskiest_tenth_fail_share']:.0%} fail; safest half: {metrics['safest_half_fail_share']:.0%}")
    print(f"  examples: high risk {metrics['examples']['high_risk']['health_score']}, healthy {metrics['examples']['healthy']['health_score']}")

    found = gates(metrics, metrics["artefact_mb"])
    if metrics != recorded:
        found.append(f"metrics differ from {artefact.METRICS_FILE} recorded at training")
    if found:
        print("FAIL:", *found, sep="\n  ", file=sys.stderr)
        return 1
    print("PASS: every FMS-53 acceptance criterion")
    return 0


if __name__ == "__main__":
    sys.exit(main())
