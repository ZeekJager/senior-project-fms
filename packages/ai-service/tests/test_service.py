"""The predictive maintenance service (FMS-54): the trained model behind an internal HTTP API."""

import shutil
import statistics
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from ml.model import health_score, probability
from ml.serving import Predictor, risk_level
from ml.spec import feature_names, spec_hash

from app import MAX_BATCH, Settings, create_app

TOKEN = "t" * 40
AUTH = {"X-Internal-Token": TOKEN}


@pytest.fixture(scope="module")
def client(trained):
    return TestClient(create_app(Settings(token=TOKEN, models_dir=trained["folder"].parent)))


def body(inputs, vehicle_id=None):
    return {"vehicle_id": vehicle_id or str(uuid.uuid4()), "as_of": "2026-10-25T01:00:00+03:00", "features": inputs}


def example(trained, name):
    """The board's example vehicle (FMS-53) as the extractor would send it: integer inputs as integers."""
    spec_int = {"days_since_last_service", "num_fault_reports", "days_since_oil_change", "days_since_coolant_change", "days_since_brake_fluid_change",
                "days_since_clutch_fluid_change", "days_since_tyre_change", "days_since_battery_change"}
    inputs = trained["metrics"]["examples"][name]["inputs"]
    return {k: int(round(v)) if k in spec_int else v for k, v in inputs.items()}


def test_health_needs_no_token_and_names_the_model(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok" and res.json()["model_version"] == "pm-2026.10"


def test_a_prediction_has_the_score_probability_risk_level_and_model_version(client, trained):
    res = client.post("/internal/ml/predict-maintenance", json=body(example(trained, "high_risk"), "6f0f2b4e-6a1c-4c3e-9a55-3c2d4f9b8e11"), headers=AUTH)
    assert res.status_code == 200
    data = res.json()["data"]
    assert set(data) == {"vehicle_id", "as_of", "failure_probability", "health_score", "risk_level", "prediction_horizon_days", "model_version", "factors"}
    assert data["vehicle_id"] == "6f0f2b4e-6a1c-4c3e-9a55-3c2d4f9b8e11"
    assert data["model_version"] == "pm-2026.10" and data["prediction_horizon_days"] == 30
    assert data["health_score"] == round((1 - data["failure_probability"]) * 100)
    # The board's high-risk vehicle, through the API.
    assert data["health_score"] < 30 and data["risk_level"] == "high"
    assert res.json()["meta"]["model_version"] == "pm-2026.10"

    healthy = client.post("/internal/ml/predict-maintenance", json=body(example(trained, "healthy")), headers=AUTH).json()["data"]
    assert healthy["health_score"] > 85 and healthy["risk_level"] == "low" and healthy["factors"] == []


def test_the_service_scores_what_the_model_scores(client, trained):
    predictor = client.app.state.predictor
    inputs = example(trained, "high_risk")
    import pandas as pd

    p = probability(predictor.model, pd.DataFrame([inputs]))[0]
    data = client.post("/internal/ml/predict-maintenance", json=body(inputs), headers=AUTH).json()["data"]
    assert data["failure_probability"] == pytest.approx(p, abs=1e-4)
    assert data["health_score"] == int(health_score([p])[0])


def test_factors_are_the_inputs_that_raise_the_risk_most(client, trained):
    data = client.post("/internal/ml/predict-maintenance", json=body(example(trained, "high_risk")), headers=AUTH).json()["data"]
    # The example differs from a typical vehicle in its service age, oil age and faults: those are what put it at risk.
    assert 1 <= len(data["factors"]) <= 3
    assert set(data["factors"]) <= {"days_since_last_service", "num_fault_reports", "days_since_oil_change", "km_since_oil_change"}
    assert set(data["factors"]) & {"days_since_last_service", "num_fault_reports"}


def test_a_batch_scores_each_vehicle_in_order(client, trained):
    ids = [str(uuid.uuid4()) for _ in range(3)]
    items = [body(example(trained, "healthy"), ids[0]), body(example(trained, "high_risk"), ids[1]), body(example(trained, "healthy"), ids[2])]
    res = client.post("/internal/ml/predict-maintenance/batch", json={"items": items}, headers=AUTH)
    assert res.status_code == 200
    data = res.json()["data"]
    assert [d["vehicle_id"] for d in data] == ids
    assert [d["risk_level"] for d in data] == ["low", "high", "low"]
    assert data[0] == {**data[2], "vehicle_id": ids[0]}


def test_a_missing_input_is_422_naming_the_field(client, trained):
    inputs = example(trained, "healthy")
    del inputs["mileage_km"]
    res = client.post("/internal/ml/predict-maintenance", json=body(inputs), headers=AUTH)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "VALIDATION_FAILED"
    assert res.json()["error"]["details"] == [{"field": "features.mileage_km", "reason": "required"}]

    inputs = example(trained, "healthy")
    del inputs["age_years"]
    res = client.post("/internal/ml/predict-maintenance/batch", json={"items": [body(example(trained, "healthy")), body(inputs)]}, headers=AUTH)
    assert res.json()["error"]["details"] == [{"field": "items.1.features.age_years", "reason": "required"}]


@pytest.mark.parametrize(
    "change, reason",
    [
        ({"mileage_km": -1}, "out_of_range"),
        ({"days_since_last_service": 731}, "out_of_range"),
        ({"num_fault_reports": 2.5}, "invalid"),
        ({"fuel_variance_pct": "high"}, "invalid"),
        ({"tyre_pressure": 7}, "not_allowed"),
    ],
)
def test_an_input_out_of_its_range_of_the_wrong_type_or_unknown_is_422(client, trained, change, reason):
    inputs = {**example(trained, "healthy"), **change}
    res = client.post("/internal/ml/predict-maintenance", json=body(inputs), headers=AUTH)
    assert res.status_code == 422
    assert res.json()["error"]["details"] == [{"field": f"features.{next(iter(change))}", "reason": reason}]


def test_the_request_names_its_vehicle_and_time_and_a_batch_has_1_to_500(client, trained):
    res = client.post("/internal/ml/predict-maintenance", json={"features": example(trained, "healthy")}, headers=AUTH)
    assert {d["field"] for d in res.json()["error"]["details"]} == {"vehicle_id", "as_of"}
    no_offset = {**body(example(trained, "healthy")), "as_of": "2026-10-25T01:00:00"}
    assert client.post("/internal/ml/predict-maintenance", json=no_offset, headers=AUTH).status_code == 422
    assert client.post("/internal/ml/predict-maintenance/batch", json={"items": []}, headers=AUTH).json()["error"]["details"] == [{"field": "items", "reason": "too_few"}]
    many = {"items": [body(example(trained, "healthy"))] * (MAX_BATCH + 1)}
    assert client.post("/internal/ml/predict-maintenance/batch", json=many, headers=AUTH).json()["error"]["details"] == [{"field": "items", "reason": "too_many"}]
    bad_json = client.post("/internal/ml/predict-maintenance", content=b"{not json", headers={**AUTH, "Content-Type": "application/json"})
    assert bad_json.status_code == 422


@pytest.mark.parametrize("path", ["/internal/ml/predict-maintenance", "/internal/ml/predict-maintenance/batch", "/model"])
def test_no_token_or_a_wrong_one_is_401(client, trained, path):
    call = (lambda h: client.get(path, headers=h)) if path == "/model" else (lambda h: client.post(path, json={"items": []} if "batch" in path else {}, headers=h))
    for headers in [{}, {"X-Internal-Token": "wrong"}, {"X-Internal-Token": TOKEN[:-1]}]:
        res = call(headers)
        assert res.status_code == 401, headers
        assert res.json()["error"]["code"] == "AUTH_TOKEN_INVALID"


def test_the_model_endpoint_says_what_is_serving(client, trained):
    res = client.get("/model", headers=AUTH)
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["model_version"] == "pm-2026.10"
    assert data["features"] == feature_names()
    assert data["feature_spec_hash"] == spec_hash()
    assert data["artefact_sha256"] == trained["metadata"]["artefact_sha256"]
    assert data["metrics"]["roc_auc"] == trained["metrics"]["roc_auc"]
    assert data["training_data"]["rows"] == 12000 and "test_vehicles" not in data["training_data"]


def test_the_request_id_is_passed_through(client):
    assert client.get("/health", headers={"X-Request-Id": "abc-123"}).headers["X-Request-Id"] == "abc-123"
    assert client.get("/health").headers["X-Request-Id"]


def test_one_vehicle_is_scored_in_under_200_ms(client, trained):
    payload = body(example(trained, "high_risk"))
    client.post("/internal/ml/predict-maintenance", json=payload, headers=AUTH)
    times = []
    for _ in range(20):
        started = time.perf_counter()
        assert client.post("/internal/ml/predict-maintenance", json=payload, headers=AUTH).status_code == 200
        times.append(time.perf_counter() - started)
    assert statistics.median(times) < 0.2, times


def test_it_refuses_to_start_without_a_usable_token_or_model(trained, tmp_path):
    with pytest.raises(RuntimeError, match="ML_SERVICE_TOKEN"):
        create_app(Settings(token="change-me", models_dir=trained["folder"].parent))
    with pytest.raises(RuntimeError, match="no model"):
        create_app(Settings(token=TOKEN, models_dir=tmp_path))
    # A model whose file is not the one its metadata names is never unpickled.
    bad = tmp_path / "models" / "pm-2026.11"
    shutil.copytree(trained["folder"], bad)
    with (bad / "model.joblib").open("r+b") as f:
        f.seek(200)
        b = f.read(1)
        f.seek(200)
        f.write(bytes([b[0] ^ 1]))
    with pytest.raises(Exception, match="checksum"):
        create_app(Settings(token=TOKEN, models_dir=tmp_path / "models"))


def test_the_newest_version_serves_unless_one_is_named(trained, tmp_path):
    models = tmp_path / "models"
    for version in ["pm-2026.09", "pm-2026.10.2", "pm-2026.10"]:
        shutil.copytree(trained["folder"], models / version)
    # Same model under three names: the folder decides which version is reported... and the metadata must match it.
    for version in ["pm-2026.09", "pm-2026.10.2"]:
        meta = models / version / "metadata.json"
        meta.write_text(meta.read_text(encoding="utf-8").replace('"pm-2026.10"', f'"{version}"'), encoding="utf-8")
    assert TestClient(create_app(Settings(token=TOKEN, models_dir=models))).get("/health").json()["model_version"] == "pm-2026.10.2"
    named = create_app(Settings(token=TOKEN, models_dir=models, model_version="pm-2026.09"))
    assert TestClient(named).get("/health").json()["model_version"] == "pm-2026.09"


def test_risk_levels_follow_the_health_score():
    assert [risk_level(s) for s in [100, 75, 74, 41, 40, 0]] == ["low", "low", "medium", "medium", "high", "high"]


def test_without_medians_a_prediction_has_no_factors(trained):
    predictor = Predictor.load(trained["folder"])
    predictor.medians = None
    [p] = predictor.predict([example(trained, "high_risk")])
    assert p["factors"] == [] and p["health_score"] < 30
