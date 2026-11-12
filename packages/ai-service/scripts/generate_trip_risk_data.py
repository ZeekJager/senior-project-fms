"""
Writes the generated trip risk dataset (FMS-155): a demonstration while the fleet has too few real trips.

    python scripts/generate_trip_risk_data.py                  # data/trip_risk_generated.csv, seed 155
    python scripts/generate_trip_risk_data.py --seed 7 --out /tmp/other.csv

Every row is source `generated`; a model trained on it is a demonstration. The fleet's own trips are exported by the
core instead (npm run ml:trip-risk-dataset -w fms-backend). Exits 1, writing nothing, if the data fails a check.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ml.trip_risk.dataset import SEED, generate, problems, to_csv  # noqa: E402
from ml.trip_risk.spec import LABELS, spec_hash  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "trip_risk_generated.csv")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    df = generate(seed=args.seed)
    found = problems(df)
    if found:
        print("The dataset failed its checks; nothing written:", *found, sep="\n  ", file=sys.stderr)
        return 1
    to_csv(df, args.out)
    rates = ", ".join(f"{label} {df[label].mean():.3f}" for label in LABELS)
    print(f"{len(df)} generated trips of {df['driver_id'].nunique()} drivers, seed {args.seed}, in {time.perf_counter() - started:.1f} s -> {args.out}")
    print(f"positive rates: {rates}")
    print(f"trip risk spec hash: {spec_hash()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
