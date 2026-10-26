"""The model train.py makes from the generated dataset, trained once and shared by the model and service tests."""

import pytest

from ml import artefact
from ml.dataset import generate, to_csv

import train as train_cli

VERSION = "pm-2026.10"


@pytest.fixture(scope="session")
def trained(tmp_path_factory):
    root = tmp_path_factory.mktemp("model")
    data = root / "training_data.csv"
    to_csv(generate(), data)
    assert train_cli.main(["--data", str(data), "--out", str(root / "models"), "--version", VERSION]) == 0
    folder = root / "models" / VERSION
    metadata, metrics = artefact.read(folder)
    return {"root": root, "data": data, "folder": folder, "metadata": metadata, "metrics": metrics}
