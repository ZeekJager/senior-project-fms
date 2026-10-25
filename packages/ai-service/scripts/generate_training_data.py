"""
Writes the synthetic training dataset (FMS-52) and checks it.

    python scripts/generate_training_data.py                 # data/training_data.csv, seed 42
    python scripts/generate_training_data.py --seed 7 --out /tmp/other.csv

Exits 1, writing nothing, if the data fails a quality check.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ml.checks import problems  # noqa: E402
from ml.dataset import MONTHS, SEED, VEHICLES, generate, to_csv  # noqa: E402
from ml.spec import feature_names, spec_hash, target_name  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "training_data.csv")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    df = generate(seed=args.seed)
    found = problems(df, rows=VEHICLES * MONTHS, months=MONTHS)
    if found:
        print("The dataset failed its checks; nothing written:", *found, sep="\n  ", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    to_csv(df, args.out)

    print(f"{len(df)} rows ({VEHICLES} vehicles x {MONTHS} months), seed {args.seed}, in {time.perf_counter() - started:.1f} s -> {args.out}")
    print(f"positive rate ({target_name()}): {df[target_name()].mean():.3f}")
    print(f"features: {', '.join(feature_names())}")
    print(f"feature spec hash: {spec_hash()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
