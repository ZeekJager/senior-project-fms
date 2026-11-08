"""The service's metrics (FMS-75, docs/metrics.md): Prometheus' text at /metrics, internal, with route templates and no URLs."""

import re
import uuid

import pytest
from fastapi.testclient import TestClient

from app import Settings, create_app

TOKEN = "t" * 40
AUTH = {"X-Internal-Token": TOKEN}


@pytest.fixture()
def client(trained):
    # A fresh app per test: each has its own registry, so one test's counts are not another's.
    return TestClient(create_app(Settings(token=TOKEN, models_dir=trained["folder"].parent)))


def sample(text: str, name: str, **labels: str) -> float | None:
    """The value of one series of a scrape, or None."""
    for line in text.splitlines():
        if not (line.startswith(name + "{") or line.startswith(name + " ")):
            continue
        if all(f'{k}="{v}"' in line for k, v in labels.items()):
            return float(line.rsplit(" ", 1)[1])
    return None


def vehicle(trained):
    inputs = trained["metrics"]["examples"]
    first = next(iter(inputs.values()))["inputs"]
    ints = {k: int(round(v)) if k.startswith("days_since") or k == "num_fault_reports" else v for k, v in first.items()}
    return {"vehicle_id": str(uuid.uuid4()), "as_of": "2026-10-25T01:00:00+03:00", "features": ints}


def test_metrics_need_the_token_as_a_header_or_a_bearer_token(client):
    assert client.get("/metrics").status_code == 401
    assert client.get("/metrics", headers={"X-Internal-Token": "x" * 40}).status_code == 401
    assert client.get("/metrics", headers={"Authorization": "Bearer " + "x" * 40}).status_code == 401
    assert client.get("/metrics", headers={"Authorization": TOKEN}).status_code == 401
    assert client.get("/metrics", headers=AUTH).status_code == 200
    assert client.get("/metrics", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_the_scrape_is_prometheus_text_and_never_cached(client):
    res = client.get("/metrics", headers=AUTH)
    assert res.headers["content-type"].startswith("text/plain")
    assert res.headers["cache-control"] == "no-store"
    assert "# TYPE http_request_duration_seconds histogram" in res.text


def test_requests_are_a_histogram_by_route_template_and_status_class(client, trained):
    batch = {"items": [vehicle(trained), vehicle(trained)]}
    assert client.post("/internal/ml/predict-maintenance/batch", json=batch, headers=AUTH).status_code == 200
    assert client.post("/internal/ml/predict-maintenance/batch", json={"items": []}, headers=AUTH).status_code == 422
    assert client.post("/internal/ml/predict-maintenance/batch", json=batch).status_code == 401
    text = client.get("/metrics", headers=AUTH).text
    route = "/internal/ml/predict-maintenance/batch"
    assert sample(text, "http_request_duration_seconds_count", method="POST", route=route, status_class="2xx") == 1
    assert sample(text, "http_request_duration_seconds_count", method="POST", route=route, status_class="4xx") == 2
    assert sample(text, "http_request_duration_seconds_sum", method="POST", route=route, status_class="2xx") > 0
    # The buckets a p95 is computed from: cumulative, ending at +Inf with the count.
    buckets = [float(l.rsplit(" ", 1)[1]) for l in text.splitlines() if l.startswith("http_request_duration_seconds_bucket{") and 'status_class="2xx"' in l]
    assert len(buckets) == 14 and buckets == sorted(buckets) and buckets[-1] == 1


def test_labels_hold_no_urls_and_strangers_are_one_series(client):
    client.get("/definitely/not/a/route/12345?secret=abc")
    client.get("/wp-admin/setup.php")
    text = client.get("/metrics", headers=AUTH).text
    assert "12345" not in text and "wp-admin" not in text and "secret" not in text
    assert sample(text, "http_request_duration_seconds_count", route="unmatched", status_class="4xx") == 2


def test_probes_and_the_scrape_are_not_measured(client):
    client.get("/health")
    client.get("/metrics", headers=AUTH)
    text = client.get("/metrics", headers=AUTH).text
    assert 'route="/health"' not in text and 'route="/metrics"' not in text


def test_predictions_are_counted_and_timed(client, trained):
    assert sample(client.get("/metrics", headers=AUTH).text, "ml_predicted_vehicles_total") == 0
    client.post("/internal/ml/predict-maintenance", json=vehicle(trained), headers=AUTH)
    client.post("/internal/ml/predict-maintenance/batch", json={"items": [vehicle(trained)] * 3}, headers=AUTH)
    text = client.get("/metrics", headers=AUTH).text
    assert sample(text, "ml_predicted_vehicles_total") == 4
    assert sample(text, "ml_prediction_duration_seconds_count") == 2


def test_the_served_model_and_its_load_time_are_exported(client, trained):
    text = client.get("/metrics", headers=AUTH).text
    version = client.get("/health").json()["model_version"]
    assert re.search(rf'ml_model_info\{{version="{re.escape(version)}"\}} 1\.0', text)
    assert sample(text, "ml_model_load_seconds") is not None
