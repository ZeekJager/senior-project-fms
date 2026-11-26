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


TRIP_RISK_VERSION = "tr-2026.11"


@pytest.fixture(scope="session")
def trip_trained(tmp_path_factory):
    """The trip risk model (FMS-155) train_trip_risk.py makes from the generated dataset: a demonstration."""
    from ml.trip_risk.dataset import generate as generate_trips
    from ml.trip_risk.dataset import to_csv as trips_to_csv

    import train_trip_risk

    root = tmp_path_factory.mktemp("trip-risk")
    data = root / "trip_risk_generated.csv"
    trips_to_csv(generate_trips(), data)
    assert train_trip_risk.main(["--data", str(data), "--out", str(root / "models"), "--version", TRIP_RISK_VERSION]) == 0
    folder = root / "models" / TRIP_RISK_VERSION
    metadata, metrics = artefact.read(folder)
    return {"root": root, "data": data, "folder": folder, "metadata": metadata, "metrics": metrics}


EV_VERSION = "pm-ev-2026.11"


@pytest.fixture(scope="session")
def ev_trained(tmp_path_factory):
    """The EV predictive maintenance model (FMS-135) train.py --spec ev makes from the generated EV dataset."""
    from ml.ev.dataset import generate as generate_ev
    from ml.ev.dataset import to_csv as ev_to_csv

    root = tmp_path_factory.mktemp("ev-model")
    data = root / "ev_training_data.csv"
    ev_to_csv(generate_ev(), data)
    assert train_cli.main(["--spec", "ev", "--data", str(data), "--out", str(root / "models"), "--version", EV_VERSION]) == 0
    folder = root / "models" / EV_VERSION
    metadata, metrics = artefact.read(folder)
    return {"root": root, "data": data, "folder": folder, "metadata": metadata, "metrics": metrics}
