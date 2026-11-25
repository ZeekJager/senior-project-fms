"""Error tracking (FMS-109, docs/observability.md): an error the service answers 500 for goes to Sentry's protocol (the
self-hosted GlitchTip, or Sentry), tagged with its request id, so the API's request id finds it. Off without SENTRY_DSN.
Nothing personal leaves: no request data, headers or users, and e-mail addresses, phone numbers and tokens in messages
are masked first."""

from __future__ import annotations

import re
from typing import Any

import sentry_sdk

_EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_PHONE = re.compile(r"\+?\d(?:[\s.-]?\d){8,}")
_BEARER = re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_OPAQUE_KEY_PATTERN = re.compile(r"\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,})\b")

_enabled = False


def scrub_text(text: str) -> str:
    text = _BEARER.sub(r"\1 [Filtered]", text)
    text = _EMAIL.sub("[email]", text)
    text = _OPAQUE_KEY_PATTERN.sub("[token]", text)
    return _PHONE.sub("[number]", text)


def scrub_event(event: dict[str, Any], _hint: Any = None) -> dict[str, Any]:
    """What may leave: the request's method and path only, no user, masked messages."""
    out = dict(event)
    request = out.get("request")
    if isinstance(request, dict):
        out["request"] = {"method": request.get("method"), "url": scrub_text(str(request.get("url", "")).split("?")[0])}
    out.pop("user", None)
    out.pop("server_name", None)
    if isinstance(out.get("message"), str):
        out["message"] = scrub_text(out["message"])
    exception = out.get("exception")
    if isinstance(exception, dict) and isinstance(exception.get("values"), list):
        for value in exception["values"]:
            if not isinstance(value, dict):
                continue
            if isinstance(value.get("value"), str):
                value["value"] = scrub_text(value["value"])
            frames = (value.get("stacktrace") or {}).get("frames") or []
            for frame in frames:
                if isinstance(frame, dict):
                    for key in ("pre_context", "context_line", "post_context", "vars"):
                        frame.pop(key, None)
    out.pop("breadcrumbs", None)
    return out


def init_error_tracking(dsn: str | None, environment: str, transport: Any = None) -> bool:
    """Starts error tracking once; a second call, or no DSN, changes nothing."""
    global _enabled
    if not dsn or _enabled:
        return _enabled
    options: dict[str, Any] = {
        "dsn": dsn,
        "environment": environment,
        # No source lines or local variables in stack frames: either can hold a person's data.
        "include_source_context": False,
        "include_local_variables": False,
        "traces_sample_rate": 0,
        "default_integrations": False,
        "before_send": scrub_event,
        "before_breadcrumb": lambda *_: None,
    }
    if transport is not None:
        options["transport"] = transport
    sentry_sdk.init(**options)
    _enabled = True
    return True


def _unwrap(exc: BaseException) -> BaseException:
    """The error itself, out of the exception groups the ASGI stack wraps a single error in."""
    while isinstance(exc, BaseExceptionGroup) and len(exc.exceptions) == 1:
        exc = exc.exceptions[0]
    return exc


def capture(exc: BaseException, request_id: str | None, route: str | None, method: str) -> None:
    if not _enabled:
        return
    exc = _unwrap(exc)
    with sentry_sdk.new_scope() as scope:
        if request_id:
            scope.set_tag("request_id", request_id)
        scope.set_tag("method", method)
        if route:
            scope.set_tag("route", route)
        scope.set_context("request", {"request_id": request_id, "method": method, "route": route})
        sentry_sdk.capture_exception(exc)


def flush(timeout: float = 2.0) -> None:
    if _enabled:
        sentry_sdk.flush(timeout)


def reset_for_tests() -> None:
    global _enabled
    _enabled = False
