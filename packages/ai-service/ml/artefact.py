"""
A trained model's folder (FMS-53): models/<model_version>/ holds the model and
everything the model registry (FMS-127) records about it.

    model.joblib            the calibrated forest
    metadata.json           version, inputs, feature spec hash, training data, checksum of model.joblib
    metrics.json            what it scores on vehicles it has not seen
    feature_importance.csv  what drives its predictions
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import joblib
import pandas as pd

from ml.spec import feature_names, spec_hash

MODEL_FILE = "model.joblib"
METADATA_FILE = "metadata.json"
METRICS_FILE = "metrics.json"
IMPORTANCE_FILE = "feature_importance.csv"

# pm-2026.10, or pm-2026.10.2 for another model the same month (the contract's model_version).
VERSION = re.compile(r"^pm-[0-9]{4}\.[0-9]{2}(\.[0-9]+)?$")


class ArtefactError(Exception):
    """The folder is not a model this code can use as it stands."""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def save(folder: Path, model, metadata: dict[str, Any], metrics: dict[str, Any], importance: pd.DataFrame) -> dict[str, Any]:
    """Writes the folder, which must not exist yet: a version names one model, never two. Returns the metadata as saved."""
    if not VERSION.match(metadata["model_version"]):
        raise ArtefactError(f"model_version {metadata['model_version']!r} is not like pm-2026.10")
    if folder.exists():
        raise ArtefactError(f"{folder} already exists; train under another --version")
    folder.mkdir(parents=True)
    joblib.dump(model, folder / MODEL_FILE, compress=3)
    saved = {**metadata, "artefact_sha256": sha256(folder / MODEL_FILE)}
    _json(folder / METADATA_FILE, saved)
    _json(folder / METRICS_FILE, metrics)
    importance.to_csv(folder / IMPORTANCE_FILE, index=False, lineterminator="\n")
    return saved


def read(folder: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """(metadata, metrics), without loading the model."""
    try:
        metadata = json.loads((folder / METADATA_FILE).read_text(encoding="utf-8"))
        metrics = json.loads((folder / METRICS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ArtefactError(f"{folder} is not a model folder: {e}") from e
    return metadata, metrics


def load(folder: Path):
    """
    (model, metadata). Refuses a model whose file is not the one its metadata
    names (the file is a pickle, so it is checked before it is opened) or whose
    inputs are not the ones this code's feature spec defines.
    """
    metadata, _ = read(folder)
    path = folder / MODEL_FILE
    if not path.is_file() or sha256(path) != metadata.get("artefact_sha256"):
        raise ArtefactError(f"{path} does not match the checksum in {METADATA_FILE}")
    if metadata.get("feature_spec_hash") != spec_hash() or metadata.get("features") != feature_names():
        raise ArtefactError(
            f"{folder.name} was trained on feature spec {metadata.get('feature_spec_hash')}, this code implements {spec_hash()}"
        )
    return joblib.load(path), metadata
