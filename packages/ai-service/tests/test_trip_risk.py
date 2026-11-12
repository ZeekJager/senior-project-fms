"""The trip risk model (FMS-155): its spec, inputs, datasets, training against the rules, and the service's endpoints."""

import json
import shutil
from datetime import datetime
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from ml import artefact
from ml.trip_risk.dataset import generate, is_demonstration, problems, shortfall, to_csv
from ml.trip_risk.features import Job, Past, trip_features
from ml.trip_risk.serving import TripRiskPredictor, newest
from ml.trip_risk.spec import LABELS, columns, feature_names, id_columns, load_spec, minimum, spec_hash

import evaluate_trip_risk
import train_trip_risk
from app import MAX_TRIP_RISK_BATCH, Settings, create_app

TOKEN = "t" * 40
AUTH = {"X-Internal-Token": TOKEN}
FIXTURE = Path(__file__).parent / "fixtures" / "trip_risk_features.json"
# Protected attributes, and anything that stands in for one, are never inputs (FMS-155).
PROTECTED = ("name", "age", "gender", "sex", "birth", "address", "home", "photo", "religion", "ethnic", "phone", "email")


@pytest.fixture(scope="module")
def generated():
    return generate()


# --- The spec --------------------------------------------------------------------------------------------------------


def test_the_spec_lists_every_input_with_its_formula_and_no_protected_attribute():
    spec = load_spec()
    names = feature_names()
    assert len(names) == len(set(names)) == 22
    for f in spec["features"]:
        assert {"name", "type", "unit", "min", "max", "decimals", "formula", "when_missing", "sources"} <= set(f), f["name"]
        assert not any(word in f["name"] for word in PROTECTED), f["name"]
    assert not set(id_columns()) & set(names)
    assert [t["name"] for t in spec["target"]] == list(LABELS)
    assert minimum() == {"trips": 2000, "drivers": 20}


def test_the_spec_hash_is_the_canonical_hash_and_differs_from_the_maintenance_spec():
    from ml.spec import spec_hash as maintenance_hash

    assert len(spec_hash()) == 64 and spec_hash() != maintenance_hash()


# --- The inputs ------------------------------------------------------------------------------------------------------


def _at(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def test_the_inputs_match_the_shared_fixture_the_core_checks_too():
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 3
    for case in cases:
        j = case["job"]
        job = Job(_at(j["scheduled_start"]), _at(j["scheduled_end"]), j["planned_distance_km"], j["planned_duration_seconds"], j["stops"], j["cargo_weight_kg"], j["cargo_kind"], j["payload_capacity_kg"])
        past = [[Past(_at(p["scheduled_end"]), _at(p["actual_start"]), _at(p["actual_end"]), p["late"], p["safety_event"], p["job_load_points"]) for p in case[k]] for k in ("driver", "route")]
        assert trip_features(job, *past) == case["expected"], case["name"]


def test_a_driver_on_a_trip_at_t_has_had_no_rest_and_only_trips_started_before_t_count():
    t = _at("2026-11-12T06:00:00Z")
    job = Job(t, _at("2026-11-12T10:00:00Z"), 100, None, 0, None, "general", None)
    under_way = Past(None, _at("2026-11-12T02:00:00Z"), None, None, False, 0)
    later = Past(None, _at("2026-11-12T07:00:00Z"), _at("2026-11-12T09:00:00Z"), False, False, 0)
    f = trip_features(job, [under_way, later], [])
    assert f["hours_since_last_trip"] == 0 and f["hours_driven_24h"] == 4 and f["driver_trips_90d"] == 0


# --- The datasets ----------------------------------------------------------------------------------------------------


def test_the_generated_dataset_is_the_same_for_a_seed_passes_its_checks_and_is_a_demonstration(generated):
    assert generated.equals(generate())
    assert not generated.equals(generate(seed=7))
    assert problems(generated) == [] and shortfall(generated) is None
    assert 10_000 <= len(generated) <= 14_000 and generated["driver_id"].nunique() == 60
    assert list(generated.columns) == columns()
    assert is_demonstration(generated)
    for label in LABELS:
        assert 0.05 < generated[label].mean() < 0.35


def test_the_checks_find_what_is_wrong(generated):
    df = generated.head(500).copy()
    assert problems(df.drop(columns=["stops"]))[0].startswith("columns are")
    bad = df.copy()
    bad.loc[0, "hours_driven_24h"] = 30
    bad.loc[1, "late"] = 2
    bad.loc[2, "source"] = "fleet"
    found = "\n".join(problems(bad))
    assert "hours_driven_24h: range" in found and "late: values other than 0 and 1" in found and "mixed" in found
    dup = pd.concat([df.head(2), df.head(1)], ignore_index=True)
    assert any("two rows" in p for p in problems(dup))


def test_too_little_data_is_refused_and_says_how_much_is_needed(generated, tmp_path):
    drivers = sorted(generated["driver_id"].unique())[:15]
    small = generated[generated["driver_id"].isin(drivers)].head(1_500)
    assert "not enough trips yet: 1,500 trips of" in shortfall(small)
    data = tmp_path / "small.csv"
    to_csv(small, data)
    assert train_trip_risk.main(["--data", str(data), "--out", str(tmp_path / "models"), "--version", "tr-2026.11"]) == 1
    assert not (tmp_path / "models").exists()
    empty = tmp_path / "empty.csv"
    to_csv(generated.head(0), empty)
    assert train_trip_risk.main(["--data", str(empty), "--out", str(tmp_path / "models")]) == 1


# --- Training --------------------------------------------------------------------------------------------------------


def test_the_demonstration_model_beats_the_rules_on_drivers_it_has_not_seen(trip_trained):
    metadata, metrics = trip_trained["metadata"], trip_trained["metrics"]
    assert metadata["name"] == "trip-risk" and metadata["model_version"] == "tr-2026.11"
    assert metadata["demonstration"] is True and metadata["training_data"]["source"] == "generated"
    assert metadata["features"] == feature_names() and metadata["feature_spec_hash"] == spec_hash()
    test_drivers = set(metadata["training_data"]["test_drivers"])
    assert 10 <= len(test_drivers) <= 14
    for label in LABELS:
        m, r = metrics[label]["model"], metrics[label]["rules"]
        assert m["roc_auc"] >= r["roc_auc"] + 0.01 and m["brier"] <= r["brier"], label
        # Calibrated: the average predicted chance is near the share that happened.
        assert abs(metrics[label]["mean_probability"] - metrics[label]["positive_rate"]) < 0.04, label
        assert [d["depot_id"] for d in metrics[label]["by_depot"]] == sorted(d["depot_id"] for d in metrics[label]["by_depot"])
        assert any(d["graded"] for d in metrics[label]["by_depot"])
    assert metrics["decision"] == {"beats_rules": True, "why": [], "min_auc_gain": 0.01}
    importance = pd.read_csv(trip_trained["folder"] / artefact.IMPORTANCE_FILE)
    assert sorted(importance["feature"]) == sorted(feature_names())


def test_evaluate_reproduces_the_recorded_metrics_and_refuses_other_data(trip_trained, tmp_path):
    assert evaluate_trip_risk.main([str(trip_trained["folder"]), "--data", str(trip_trained["data"])]) == 0
    other = tmp_path / "other.csv"
    to_csv(generate(seed=7), other)
    assert evaluate_trip_risk.main([str(trip_trained["folder"]), "--data", str(other)]) == 1


def test_a_model_that_does_not_beat_the_rules_is_written_with_the_reason(generated, tmp_path):
    # Outcomes shuffled within each driver: the driver's own rate is all there is to learn, which the rules already know.
    drivers = sorted(generated["driver_id"].unique())[:30]
    df = generated[generated["driver_id"].isin(drivers)].copy().reset_index(drop=True)
    for label in LABELS:
        df[label] = df.groupby("driver_id")[label].transform(lambda s: s.sample(frac=1, random_state=1).to_numpy())
    data = tmp_path / "shuffled.csv"
    to_csv(df, data)
    assert train_trip_risk.main(["--data", str(data), "--out", str(tmp_path / "models"), "--version", "tr-2026.11"]) == 0
    _, metrics = artefact.read(tmp_path / "models" / "tr-2026.11")
    assert metrics["decision"]["beats_rules"] is False and metrics["decision"]["why"]


def test_a_version_is_never_reused_and_must_look_like_tr(trip_trained):
    out = str(trip_trained["folder"].parent)
    assert train_trip_risk.main(["--data", str(trip_trained["data"]), "--out", out, "--version", "tr-2026.11"]) == 1
    assert train_trip_risk.main(["--data", str(trip_trained["data"]), "--out", out, "--version", "pm-2026.11"]) == 2


def test_a_tampered_model_or_one_for_other_inputs_is_refused(trip_trained, tmp_path):
    copy = tmp_path / "tr-2026.11"
    shutil.copytree(trip_trained["folder"], copy)
    (copy / artefact.MODEL_FILE).write_bytes((copy / artefact.MODEL_FILE).read_bytes() + b"x")
    with pytest.raises(artefact.ArtefactError, match="checksum"):
        TripRiskPredictor.load(copy)
    other = tmp_path / "tr-2026.12"
    shutil.copytree(trip_trained["folder"], other)
    meta = json.loads((other / artefact.METADATA_FILE).read_text(encoding="utf-8"))
    (other / artefact.METADATA_FILE).write_text(json.dumps({**meta, "feature_spec_hash": "0" * 64}), encoding="utf-8")
    with pytest.raises(artefact.ArtefactError, match="feature spec"):
        TripRiskPredictor.load(other)


# --- Predictions -----------------------------------------------------------------------------------------------------


def _inputs(generated, **changes):
    row = generated[feature_names()].median().to_dict()
    ints = {f["name"] for f in load_spec()["features"] if f["type"] == "int"}
    out = {k: int(round(v)) if k in ints else float(v) for k, v in row.items()}
    return {**out, **changes}


def test_a_tired_driver_on_a_heavy_night_job_is_riskier_and_the_factors_say_why(trip_trained, generated):
    predictor = TripRiskPredictor.load(trip_trained["folder"])
    rested = _inputs(generated, hours_driven_24h=0.0, hours_since_last_trip=30.0, night_hours=0.0, job_load_points=1)
    tired = _inputs(generated, hours_driven_24h=12.5, hours_since_last_trip=3.0, night_hours=6.0, job_load_points=5)
    a, b = predictor.predict([rested, tired])
    assert b["late_probability"] > a["late_probability"] and b["safety_event_probability"] > a["safety_event_probability"]
    assert b["model_version"] == "tr-2026.11" and b["demonstration"] is True
    for label in LABELS:
        assert len(b["factors"][label]) <= 2
        for f in b["factors"][label]:
            assert f["feature"] in feature_names() and f["value"] == tired[f["feature"]]
    raised = {f["feature"] for label in LABELS for f in b["factors"][label]}
    assert raised & {"hours_driven_24h", "hours_since_last_trip", "night_hours", "job_load_points"}


def test_newest_picks_the_latest_trip_risk_version_and_none_without_one(tmp_path):
    assert newest(tmp_path) is None and newest(tmp_path / "missing") is None
    for name in ("tr-2026.11", "tr-2026.11.2", "tr-2026.09", "pm-2026.12", "tr-junk"):
        (tmp_path / name).mkdir()
    assert newest(tmp_path).name == "tr-2026.11.2"


# --- The service -----------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def both(trained, trip_trained, tmp_path_factory):
    """A service with both models, as the image builds it."""
    models = tmp_path_factory.mktemp("both")
    shutil.copytree(trained["folder"], models / trained["folder"].name)
    shutil.copytree(trip_trained["folder"], models / trip_trained["folder"].name)
    return TestClient(create_app(Settings(token=TOKEN, models_dir=models)))


def _item(inputs, driver="d-1"):
    return {"trip_id": "trip-1", "driver_id": driver, "features": inputs}


def test_the_service_serves_the_trip_risk_model_beside_the_maintenance_one(both, generated):
    health = both.get("/health").json()
    assert health["model_version"] == "pm-2026.10" and health["trip_risk_model_version"] == "tr-2026.11"
    model = both.get("/models/trip-risk", headers=AUTH).json()["data"]
    assert model["name"] == "trip-risk" and model["demonstration"] is True and model["feature_spec_hash"] == spec_hash()
    assert model["metrics"]["decision"]["beats_rules"] is True and model["minimum"] == {"trips": 2000, "drivers": 20}
    assert "test_drivers" not in model["training_data"]
    res = both.post("/internal/ml/predict-trip-risk", json={"items": [_item(_inputs(generated), "d-1"), _item(_inputs(generated, hours_driven_24h=12.0), "d-2")]}, headers=AUTH)
    assert res.status_code == 200
    data = res.json()["data"]
    assert [d["driver_id"] for d in data] == ["d-1", "d-2"]
    assert set(data[0]) == {"trip_id", "driver_id", "late_probability", "safety_event_probability", "factors", "model_version", "demonstration"}
    assert res.json()["meta"]["model_version"] == "tr-2026.11"
    # The maintenance model is untouched.
    assert both.get("/model", headers=AUTH).json()["data"]["name"] == "predictive-maintenance"


def test_trip_risk_requests_are_checked_against_the_spec(both, generated):
    good = _inputs(generated)
    cases = [
        ({k: v for k, v in good.items() if k != "stops"}, "items.0.features.stops", "required"),
        ({**good, "hours_driven_24h": 25.0}, "items.0.features.hours_driven_24h", "out_of_range"),
        ({**good, "stops": 2.5}, "items.0.features.stops", "invalid"),
        ({**good, "driver_age": 40}, "items.0.features.driver_age", "not_allowed"),
    ]
    for features, field, reason in cases:
        res = both.post("/internal/ml/predict-trip-risk", json={"items": [_item(features)]}, headers=AUTH)
        assert res.status_code == 422, field
        assert {"field": field, "reason": reason} in res.json()["error"]["details"], res.json()
    assert both.post("/internal/ml/predict-trip-risk", json={"items": []}, headers=AUTH).status_code == 422
    too_many = {"items": [_item(good, f"d-{i}") for i in range(MAX_TRIP_RISK_BATCH + 1)]}
    assert both.post("/internal/ml/predict-trip-risk", json=too_many, headers=AUTH).status_code == 422


def test_trip_risk_endpoints_need_the_token(both, generated):
    assert both.get("/models/trip-risk").status_code == 401
    assert both.post("/internal/ml/predict-trip-risk", json={"items": [_item(_inputs(generated))]}, headers={"X-Internal-Token": "x" * 40}).status_code == 401


def test_without_a_trip_risk_model_the_service_runs_and_says_so(trained):
    client = TestClient(create_app(Settings(token=TOKEN, models_dir=trained["folder"].parent)))
    assert client.get("/health").json()["trip_risk_model_version"] is None
    res = client.get("/models/trip-risk", headers=AUTH)
    assert res.status_code == 404 and res.json()["error"]["code"] == "NOT_FOUND"
    assert client.post("/internal/ml/predict-trip-risk", json={"items": [{"trip_id": "t", "driver_id": "d", "features": {}}]}, headers=AUTH).status_code in (404, 422)
