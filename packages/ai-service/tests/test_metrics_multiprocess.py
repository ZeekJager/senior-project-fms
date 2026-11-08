"""With several workers (FMS-75): each worker writes its counts to PROMETHEUS_MULTIPROC_DIR and a scrape adds them up.

prometheus_client chooses how it stores values when it is first imported, so each "worker" here is a process of its own,
as it is in the image (uvicorn --workers 2).
"""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "t" * 40

WORKER = r"""
import json, sys, uuid
from fastapi.testclient import TestClient
from app import Settings, create_app

models, predictions, scrape = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "scrape"
client = TestClient(create_app(Settings(token="t" * 40, models_dir=__import__("pathlib").Path(models))))
auth = {"X-Internal-Token": "t" * 40}
features = json.loads(sys.argv[4])
for _ in range(predictions):
    body = {"vehicle_id": str(uuid.uuid4()), "as_of": "2026-10-25T01:00:00+03:00", "features": features}
    assert client.post("/internal/ml/predict-maintenance", json=body, headers=auth).status_code == 200
if scrape:
    print(client.get("/metrics", headers=auth).text)
"""


def run_worker(models: Path, folder: Path, predictions: int, scrape: bool, features: dict) -> str:
    env = {**os.environ, "PROMETHEUS_MULTIPROC_DIR": str(folder)}
    done = subprocess.run(
        [sys.executable, "-c", WORKER, str(models), str(predictions), "scrape" if scrape else "quiet", json.dumps(features)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert done.returncode == 0, done.stderr[-2000:]
    return done.stdout


def test_a_scrape_adds_up_what_every_worker_counted(trained, tmp_path):
    first = next(iter(trained["metrics"]["examples"].values()))["inputs"]
    features = {k: int(round(v)) if k.startswith("days_since") or k == "num_fault_reports" else v for k, v in first.items()}
    folder = tmp_path / "prom"
    folder.mkdir()
    models = trained["folder"].parent

    run_worker(models, folder, predictions=1, scrape=False, features=features)  # worker 1 scored 1
    run_worker(models, folder, predictions=2, scrape=False, features=features)  # worker 2 scored 2
    text = run_worker(models, folder, predictions=0, scrape=True, features=features)  # the scrape reached a third process

    def value(name: str, **labels: str) -> float:
        for line in text.splitlines():
            if (line.startswith(name + "{") or line.startswith(name + " ")) and all(f'{k}="{v}"' in line for k, v in labels.items()):
                return float(line.rsplit(" ", 1)[1])
        raise AssertionError(f"{name} {labels} not in the scrape")

    assert value("ml_predicted_vehicles_total") == 3
    assert value("http_request_duration_seconds_count", method="POST", route="/internal/ml/predict-maintenance", status_class="2xx") == 3
    assert value("ml_prediction_duration_seconds_count") == 3
