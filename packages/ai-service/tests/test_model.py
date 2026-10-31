"""The predictive maintenance model (FMS-53): trained, graded on vehicles it has not seen, and saved with its version."""

import json
import shutil

import pandas as pd
import pytest

from ml import artefact, model
from ml.dataset import generate, to_csv
from ml.model import gates, health_score, split
from ml.spec import feature_names, spec_hash, target_name

import evaluate as evaluate_cli
import train as train_cli

from conftest import VERSION


def test_the_split_holds_out_one_vehicle_in_five_with_the_fleets_share_of_failures():
    df = generate()
    train, test = split(df)
    assert set(train["vehicle_id"]).isdisjoint(test["vehicle_id"])
    assert len(train) + len(test) == len(df)
    assert 95 <= test["vehicle_id"].nunique() <= 105
    assert abs(test[target_name()].mean() - df[target_name()].mean()) < 0.02


def test_it_ranks_unseen_vehicles_and_scores_the_board_examples(trained):
    m = trained["metrics"]
    assert m["roc_auc"] >= 0.75
    assert m["examples"]["high_risk"]["health_score"] < 30
    assert m["examples"]["healthy"]["health_score"] > 85
    assert gates(m, m["artefact_mb"]) == []
    # Ranking: the riskiest tenth fail far more often than the fleet, the safest half far less.
    assert m["riskiest_tenth_fail_share"] > 2.5 * m["test"]["positive_rate"] > 5 * m["safest_half_fail_share"]


def test_the_examples_are_typical_vehicles_with_the_oil_changed_at_the_service(trained):
    high, healthy = (trained["metrics"]["examples"][k]["inputs"] for k in ("high_risk", "healthy"))
    assert list(high) == feature_names()
    assert (high["days_since_last_service"], high["num_fault_reports"], high["days_since_oil_change"]) == (100, 5, 100)
    assert (healthy["days_since_last_service"], healthy["num_fault_reports"], healthy["days_since_oil_change"]) == (10, 0, 10)
    assert high["age_years"] == healthy["age_years"]


def test_its_probabilities_are_honest_so_the_cores_alert_threshold_flags_a_fair_share(trained):
    # Calibrated: the average predicted risk is the share that fails. Unweighted forests crowd to the middle,
    # class weights inflate it: either would put far more of the fleet below 75 every night.
    m = trained["metrics"]
    assert abs(m["mean_probability"] - m["test"]["positive_rate"]) < 0.03
    alert = m["at_alert_threshold"]
    assert alert["health_score_below"] == 75
    assert 0.10 < alert["flagged_share"] < 0.35
    assert alert["precision"] > 1.8 * m["test"]["positive_rate"]
    assert alert["recall"] > 0.5
    assert alert["f1"] == pytest.approx(2 * alert["precision"] * alert["recall"] / (alert["precision"] + alert["recall"]), abs=1e-3)


def test_the_folder_carries_its_version_inputs_spec_hash_training_data_and_checksum(trained):
    folder, meta = trained["folder"], trained["metadata"]
    assert sorted(p.name for p in folder.iterdir()) == ["feature_importance.csv", "metadata.json", "metrics.json", "model.joblib"]
    assert meta["model_version"] == VERSION and meta["name"] == "predictive-maintenance"
    assert meta["features"] == feature_names()
    assert meta["feature_spec_hash"] == spec_hash()
    assert meta["artefact_sha256"] == artefact.sha256(folder / "model.joblib")
    data = meta["training_data"]
    assert (data["rows"], data["vehicles"], data["from"], data["to"]) == (12000, 500, "2024-10-01", "2026-09-01")
    assert data["sha256"] == artefact.sha256(trained["data"])
    assert data["train_rows"] + data["test_rows"] == 12000 and len(data["test_vehicles"]) == trained["metrics"]["test"]["vehicles"]
    assert (folder / "model.joblib").stat().st_size < 50e6
    # The training rows' typical inputs, which the service explains a prediction against (FMS-54).
    assert list(meta["feature_medians"]) == feature_names()
    assert meta["feature_medians"]["age_years"] == trained["metrics"]["examples"]["high_risk"]["inputs"]["age_years"]


def test_feature_importance_lists_every_input_most_important_first(trained):
    imp = pd.read_csv(trained["folder"] / "feature_importance.csv")
    assert list(imp.columns) == ["feature", "auc_drop_when_shuffled", "impurity_importance"]
    assert sorted(imp["feature"]) == sorted(feature_names())
    assert imp["auc_drop_when_shuffled"].is_monotonic_decreasing
    assert imp["impurity_importance"].sum() == pytest.approx(1.0, abs=0.01)
    # The board's two signals and the part history all count.
    top = set(imp["feature"].head(6))
    assert {"num_fault_reports", "days_since_last_service"} <= top
    assert any(f.startswith("km_since_") for f in top)


def test_evaluate_grades_it_again_and_gets_what_training_recorded(trained, capsys):
    assert evaluate_cli.main([str(trained["folder"]), "--data", str(trained["data"])]) == 0
    out = capsys.readouterr().out
    assert "ROC-AUC" in out and "precision" in out and "PASS" in out


def test_a_tampered_model_or_one_for_other_inputs_is_refused(trained, tmp_path, capsys):
    bad = tmp_path / VERSION
    shutil.copytree(trained["folder"], bad)
    with (bad / "model.joblib").open("r+b") as f:
        f.seek(100)
        byte = f.read(1)
        f.seek(100)
        f.write(bytes([byte[0] ^ 1]))
    with pytest.raises(artefact.ArtefactError, match="checksum"):
        artefact.load(bad)
    assert evaluate_cli.main([str(bad), "--data", str(trained["data"])]) == 1

    other = tmp_path / "other" / VERSION
    shutil.copytree(trained["folder"], other)
    meta = json.loads((other / "metadata.json").read_text(encoding="utf-8"))
    meta["feature_spec_hash"] = "0" * 64
    (other / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(artefact.ArtefactError, match="feature spec"):
        artefact.load(other)


def test_evaluate_refuses_data_the_model_was_not_trained_on(trained, tmp_path, capsys):
    other = tmp_path / "other.csv"
    to_csv(generate(seed=7), other)
    assert evaluate_cli.main([str(trained["folder"]), "--data", str(other)]) == 1
    assert "not the data" in capsys.readouterr().err


def test_train_refuses_a_taken_or_malformed_version_and_bad_data(trained, tmp_path, capsys):
    out = trained["root"] / "models"
    assert train_cli.main(["--data", str(trained["data"]), "--out", str(out), "--version", VERSION]) == 1
    assert "already exists" in capsys.readouterr().err
    assert train_cli.main(["--data", str(trained["data"]), "--out", str(out), "--version", "latest"]) == 2

    broken = tmp_path / "broken.csv"
    pd.read_csv(trained["data"]).drop(columns=["age_years"]).to_csv(broken, index=False)
    assert train_cli.main(["--data", str(broken), "--out", str(tmp_path / "m"), "--version", "pm-2026.11"]) == 1
    assert "failed its checks" in capsys.readouterr().err
    assert not (tmp_path / "m").exists()


def test_a_model_missing_its_criteria_is_not_written(trained, tmp_path, monkeypatch, capsys):
    fitted, _ = artefact.load(trained["folder"])
    monkeypatch.setattr(train_cli, "fit", lambda train: fitted)
    monkeypatch.setattr(model, "MIN_ROC_AUC", 0.99)
    assert train_cli.main(["--data", str(trained["data"]), "--out", str(tmp_path), "--version", "pm-2026.11"]) == 1
    assert "ROC-AUC" in capsys.readouterr().err
    assert not (tmp_path / "pm-2026.11").exists()


def test_the_health_score_is_the_chance_of_no_failure_in_percent():
    assert health_score([0.8, 0.0, 1.0, 0.18]).tolist() == [20, 100, 0, 82]


def test_gates_name_each_criterion_missed():
    metrics = {"roc_auc": 0.7, "examples": {"high_risk": {"health_score": 30}, "healthy": {"health_score": 85}}}
    assert gates(metrics, 50.0) == [
        "ROC-AUC 0.700 on unseen vehicles, needs at least 0.75",
        "high-risk example scores 30, needs below 30",
        "healthy example scores 85, needs above 85",
        "model file is 50.0 MB, needs under 50",
    ]
