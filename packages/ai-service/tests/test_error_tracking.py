"""Error tracking (FMS-109): an error the service answers 500 for reaches error tracking with its request id, and
nothing personal goes with it."""

from __future__ import annotations

import pytest
import sentry_sdk
from fastapi.testclient import TestClient
from sentry_sdk.transport import Transport

from app import Settings, create_app
from ml import error_tracking

TOKEN = "t" * 40


class Captured(Transport):
    """A transport that keeps the events instead of sending them."""

    def __init__(self, options=None):
        super().__init__(options)
        self.events: list[dict] = []

    def capture_envelope(self, envelope):
        event = envelope.get_event()
        if event is not None:
            self.events.append(event)


@pytest.fixture()
def captured():
    error_tracking.reset_for_tests()
    transport = Captured()
    assert error_tracking.init_error_tracking("https://public@glitchtip.example/1", "test", transport=transport)
    yield transport
    sentry_sdk.get_client().close()
    error_tracking.reset_for_tests()


def test_a_thrown_error_appears_in_error_tracking_with_the_request_id(trained, captured):
    app = create_app(Settings(token=TOKEN, models_dir=trained["folder"].parent))

    @app.get("/internal/boom")
    def boom():
        raise RuntimeError("scoring failed for driver abebe@example.com, phone +251 911 234 567")

    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/internal/boom", headers={"X-Request-Id": "req-123", "X-Internal-Token": TOKEN})
    assert res.status_code == 500
    assert res.json()["error"]["code"] == "INTERNAL_SERVER_ERROR"
    assert res.json()["meta"]["request_id"] == "req-123"
    error_tracking.flush()

    assert len(captured.events) == 1
    event = captured.events[0]
    assert event["tags"]["request_id"] == "req-123"
    assert event["tags"]["route"] == "/internal/boom"
    text = str(event)
    assert "abebe@example.com" not in text and "911 234 567" not in text
    values = event["exception"]["values"]
    assert values[-1]["type"] == "RuntimeError"
    assert "[email]" in values[-1]["value"] and "[number]" in values[-1]["value"]
    assert "user" not in event


def test_scrubbing_masks_tokens_and_keeps_no_request_data():
    event = {
        "message": "Bearer abcdef.ghijk failed",
        "request": {"method": "POST", "url": "http://ai/internal/ml?token=secret", "headers": {"cookie": "x"}, "data": {"a": 1}},
        "user": {"email": "x@y.zz"},
        "server_name": "host-1",
    }
    out = error_tracking.scrub_event(event)
    assert out["request"] == {"method": "POST", "url": "http://ai/internal/ml"}
    assert out["message"] == "Bearer [Filtered] failed"
    assert "user" not in out and "server_name" not in out


def test_off_without_a_dsn():
    error_tracking.reset_for_tests()
    assert error_tracking.init_error_tracking(None, "test") is False
    # Capturing with it off is nothing.
    error_tracking.capture(RuntimeError("x"), "r", "/x", "GET")
