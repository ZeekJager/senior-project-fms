"""The EV predictive maintenance model (FMS-135): trained on its own spec, graded, and served beside the combustion model."""

import shutil
import uuid

import pytest
from fastapi.testclient import TestClient

from ml import artefact
from ml.ev import spec as ev_spec
from ml.model import EV, EV_MODEL_NAME, MODEL_NAME, gates
from ml.serving import Predictor
from ml.spec import feature_names, spec_hash

import evaluate as evaluate_cli
import train as train_cli
from app import Settings, create_app

from conftest import EV_VERSION, VERSION

TOKEN = "t" * 40
AUTH = {"X-Internal-Token": TOKEN}
INTS = {f["name"] for f in ev_spec.load_spec()["features"] if f["type"] == "int"}


def ev_inputs(ev_trained, name="healthy"):
    inputs = ev_trained["metrics"]["examples"][name]["inputs"]
    return {k: int(round(v)) if k in INTS else v for k, v in inputs.items()}


def body(inputs):
    return {"vehicle_id": str(uuid.uuid4()), "as_of": "2026-11-26T00:00:00+03:00", "features": inputs}


@pytest.fixture(scope="module")
def both(trained, ev_trained, tmp_path_factory):
    """A models folder with the combustion model and the EV model, as the image has them."""
    models = tmp_path_factory.mktemp("both")
    shutil.copytree(trained["folder"], models / VERSION)
    shutil.copytree(ev_trained["folder"], models / EV_VERSION)
    return models


@pytest.fixture(scope="module")
def client(both):
    return TestClient(create_app(Settings(token=TOKEN, models_dir=both)))


# Training and grading.


def test_the_ev_model_passes_its_grading_on_vehicles_it_has_not_seen(ev_trained):
    m, meta = ev_trained["metrics"], ev_trained["metadata"]
    assert m["roc_auc"] >= 0.75
    assert gates(m, m["artefact_mb"]) == []
    assert m["examples"]["high_risk"]["health_score"] < 30 < 85 < m["examples"]["healthy"]["health_score"]
    # Calibrated: the mean probability is the held-out vehicles' failure rate, give or take.
    assert abs(m["mean_probability"] - m["test"]["positive_rate"]) < 0.04
    assert meta["name"] == EV_MODEL_NAME and meta["model_version"] == EV_VERSION
    assert meta["features"] == ev_spec.feature_names() and meta["feature_spec_hash"] == ev_spec.spec_hash()
    assert not any(word in name for name in meta["features"] for word in ev_spec.COMBUSTION_ONLY)


def test_evaluate_grades_the_ev_model_again_on_its_own_spec(ev_trained, capsys):
    assert evaluate_cli.main([str(ev_trained["folder"]), "--data", str(ev_trained["data"])]) == 0
    assert "PASS" in capsys.readouterr().out


def test_train_refuses_the_wrong_spec_data_or_version(trained, ev_trained, tmp_path, capsys):
    # The combustion dataset is not the EV spec's columns.
    assert train_cli.main(["--spec", "ev", "--data", str(trained["data"]), "--out", str(tmp_path), "--version", "pm-ev-2026.12"]) == 1
    assert "columns are" in capsys.readouterr().err
    # An EV model is named pm-ev-*, and a combustion one never is.
    assert train_cli.main(["--spec", "ev", "--data", str(ev_trained["data"]), "--out", str(tmp_path), "--version", "pm-2026.12"]) == 2
    assert train_cli.main(["--data", str(trained["data"]), "--out", str(tmp_path), "--version", "pm-ev-2026.12"]) == 2
    assert not any(tmp_path.iterdir())


def test_a_model_is_loaded_only_as_its_own_kind(trained, ev_trained):
    with pytest.raises(artefact.ArtefactError):
        Predictor.load(ev_trained["folder"])  # as the combustion model
    with pytest.raises(artefact.ArtefactError):
        Predictor.load(trained["folder"], EV)
    assert Predictor.load(ev_trained["folder"], EV).name == EV_MODEL_NAME


# The service.


def test_the_service_serves_both_models_and_names_them(client):
    health = client.get("/health").json()
    assert (health["model_version"], health["ev_model_version"]) == (VERSION, EV_VERSION)
    assert client.get("/model", headers=AUTH).json()["data"]["name"] == MODEL_NAME
    ev = client.get("/model", params={"name": EV_MODEL_NAME}, headers=AUTH).json()["data"]
    assert (ev["name"], ev["model_version"], ev["feature_spec_hash"]) == (EV_MODEL_NAME, EV_VERSION, ev_spec.spec_hash())
    listed = client.get("/models", headers=AUTH).json()["data"]
    assert [(m["name"], m["model_version"]) for m in listed] == [(MODEL_NAME, VERSION), (EV_MODEL_NAME, EV_VERSION)]
    assert client.get("/model", params={"name": "warp-drive"}, headers=AUTH).status_code == 404


def test_an_ev_batch_is_scored_by_the_ev_model(client, ev_trained):
    items = [body(ev_inputs(ev_trained, "healthy")), body(ev_inputs(ev_trained, "high_risk"))]
    res = client.post("/internal/ml/predict-maintenance/batch", params={"model": EV_MODEL_NAME}, json={"items": items}, headers=AUTH)
    assert res.status_code == 200, res.json()
    healthy, risky = res.json()["data"]
    assert healthy["model_name"] == risky["model_name"] == EV_MODEL_NAME and healthy["model_version"] == EV_VERSION
    assert healthy["health_score"] > 85 > 30 > risky["health_score"]
    assert res.json()["meta"] == {"request_id": res.json()["meta"]["request_id"], "model_name": EV_MODEL_NAME, "model_version": EV_VERSION}


def test_each_model_refuses_the_other_specs_inputs(client, trained, ev_trained):
    ev = ev_inputs(ev_trained)
    combustion = trained["metrics"]["examples"]["healthy"]["inputs"]
    # An EV's inputs to the combustion model: the engine's inputs are missing, the battery's unknown.
    res = client.post("/internal/ml/predict-maintenance/batch", json={"items": [body(ev)]}, headers=AUTH)
    assert res.status_code == 422
    reasons = {(d["field"], d["reason"]) for d in res.json()["error"]["details"]}
    assert ("items.0.features.days_since_oil_change", "required") in reasons
    assert ("items.0.features.battery_health_pct", "not_allowed") in reasons
    # And a combustion vehicle's to the EV model.
    res = client.post("/internal/ml/predict-maintenance/batch", params={"model": EV_MODEL_NAME}, json={"items": [body(combustion)]}, headers=AUTH)
    assert res.status_code == 422
    assert ("items.0.features.battery_health_pct", "required") in {(d["field"], d["reason"]) for d in res.json()["error"]["details"]}


def test_the_combustion_batch_is_unchanged_and_names_its_model(client, trained):
    inputs = {k: v for k, v in trained["metrics"]["examples"]["healthy"]["inputs"].items()}
    ints = {f for f in feature_names() if f.startswith("days_") or f == "num_fault_reports"}
    inputs = {k: int(round(v)) if k in ints else v for k, v in inputs.items()}
    res = client.post("/internal/ml/predict-maintenance/batch", json={"items": [body(inputs)]}, headers=AUTH)
    assert res.status_code == 200, res.json()
    assert res.json()["data"][0]["model_name"] == MODEL_NAME and res.json()["data"][0]["model_version"] == VERSION
    assert client.get("/model", headers=AUTH).json()["data"]["feature_spec_hash"] == spec_hash()


def test_without_an_ev_model_the_service_says_so_and_serves_the_combustion_model(trained, ev_trained):
    alone = TestClient(create_app(Settings(token=TOKEN, models_dir=trained["folder"].parent)))
    assert alone.get("/health").json()["ev_model_version"] is None
    assert alone.get("/model", params={"name": EV_MODEL_NAME}, headers=AUTH).status_code == 404
    res = alone.post("/internal/ml/predict-maintenance/batch", params={"model": EV_MODEL_NAME}, json={"items": [body(ev_inputs(ev_trained))]}, headers=AUTH)
    assert res.status_code == 404 and res.json()["error"]["code"] == "NOT_FOUND"
    assert [m["name"] for m in alone.get("/models", headers=AUTH).json()["data"]] == [MODEL_NAME]


def test_an_ev_folder_is_never_taken_for_the_combustion_model(ev_trained, tmp_path):
    shutil.copytree(ev_trained["folder"], tmp_path / EV_VERSION)
    with pytest.raises(RuntimeError, match="no model"):
        create_app(Settings(token=TOKEN, models_dir=tmp_path))


def test_a_tampered_ev_model_stops_the_service(trained, ev_trained, tmp_path):
    shutil.copytree(trained["folder"], tmp_path / VERSION)
    shutil.copytree(ev_trained["folder"], tmp_path / EV_VERSION)
    with (tmp_path / EV_VERSION / artefact.MODEL_FILE).open("ab") as f:
        f.write(b"tampered")
    with pytest.raises(artefact.ArtefactError, match="checksum"):
        create_app(Settings(token=TOKEN, models_dir=tmp_path))
