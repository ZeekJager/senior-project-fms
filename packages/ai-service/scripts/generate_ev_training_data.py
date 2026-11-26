"""
Writes the synthetic EV training dataset (FMS-134) and checks it against feature_spec_ev.json.

    python scripts/generate_ev_training_data.py                 # data/ev_training_data.csv, seed 134
    python scripts/generate_ev_training_data.py --seed 7 --out /tmp/other.csv

Exits 1, writing nothing, if the data fails a quality check. The file is never committed (data/ is ignored).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ml.checks import problems  # noqa: E402
from ml.ev.dataset import MONTHS, SEED, VEHICLES, generate, to_csv  # noqa: E402
from ml.ev.spec import feature_names, load_spec, spec_hash, target_name  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "ev_training_data.csv")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    df = generate(seed=args.seed)
    found = problems(df, rows=VEHICLES * MONTHS, months=MONTHS, spec=load_spec())
    if found:
        print("The EV dataset failed its checks; nothing written:", *found, sep="\n  ", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    to_csv(df, args.out)

    print(f"{len(df)} rows ({VEHICLES} EVs x {MONTHS} months), seed {args.seed}, in {time.perf_counter() - started:.1f} s -> {args.out}")
    print(f"positive rate ({target_name()}): {df[target_name()].mean():.3f}")
    print(f"features: {', '.join(feature_names())}")
    print(f"EV feature spec hash: {spec_hash()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
