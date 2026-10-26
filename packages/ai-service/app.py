"""
The predictive maintenance service (FMS-54, ADR-02): the trained model behind
an internal HTTP API, so the core never runs Python. docs/ml-service.md.

    uvicorn app:create_app --factory --host 0.0.0.0 --port 5000

Reads ML_SERVICE_TOKEN (required, at least 32 characters), ML_MODELS_DIR
(default ./models) and ML_MODEL_VERSION (default: the newest folder there).
"""

from __future__ import annotations

import hmac
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, create_model

from ml import artefact
from ml.serving import Predictor
from ml.spec import load_spec

ROOT = Path(__file__).resolve().parent
AUTH_HEADER = "X-Internal-Token"
REQUEST_ID_HEADER = "X-Request-Id"
MIN_TOKEN_LENGTH = 32
# One nightly scoring call scores this many vehicles at most (FMS-55 sends batches).
MAX_BATCH = 500


@dataclass(frozen=True)
class Settings:
    token: str
    models_dir: Path
    model_version: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        shared_with_core = env.get("ML_SERVICE_TOKEN", "")
        return cls(shared_with_core, Path(env.get("ML_MODELS_DIR") or ROOT / "models"), env.get("ML_MODEL_VERSION") or None)


def model_folder(settings: Settings) -> Path:
    """ML_MODEL_VERSION's folder, or the newest version in ML_MODELS_DIR (pm-2026.10.2 after pm-2026.10)."""
    if settings.model_version:
        return settings.models_dir / settings.model_version
    versions = [p for p in settings.models_dir.glob("pm-*") if p.is_dir() and artefact.VERSION.match(p.name)] if settings.models_dir.is_dir() else []
    if not versions:
        raise RuntimeError(f"no model in {settings.models_dir}: run scripts/train.py, or set ML_MODELS_DIR")
    return max(versions, key=lambda p: tuple(int(n) for n in re.findall(r"\d+", p.name)))


# The request bodies, from feature_spec.json: every input required, within its range, nothing else.
_SPEC = load_spec()["features"]
Features = create_model(
    "Features",
    __config__=ConfigDict(extra="forbid"),
    **{f["name"]: (int if f["type"] == "int" else float, Field(ge=f["min"], le=f["max"], strict=True)) for f in _SPEC},
)


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vehicle_id: uuid.UUID
    as_of: AwareDatetime
    features: Features  # type: ignore[valid-type]


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[PredictRequest] = Field(min_length=1, max_length=MAX_BATCH)


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list[dict[str, str]] | None = None):
        self.status, self.code, self.message, self.details = status, code, message, details or []


# Pydantic's error types, as the core's validation reasons (api-contract §3.4).
REASONS = {
    "missing": "required",
    "greater_than_equal": "out_of_range",
    "less_than_equal": "out_of_range",
    "extra_forbidden": "not_allowed",
    "too_short": "too_few",
    "too_long": "too_many",
    "json_invalid": "invalid_json",
}


def _field(loc: tuple) -> str:
    return ".".join(str(part) for part in loc if part != "body")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Loads the model once, then serves it. Refuses to start without a usable token or model."""
    settings = settings or Settings.from_env()
    if len(settings.token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(f"ML_SERVICE_TOKEN must be at least {MIN_TOKEN_LENGTH} characters (run make env)")
    folder = model_folder(settings)
    started = time.perf_counter()
    predictor = Predictor.load(folder)
    _, metrics = artefact.read(folder)
    load_seconds = round(time.perf_counter() - started, 2)

    # No interactive docs: the API is internal, and documented in docs/api-contract.md §10.3.
    app = FastAPI(title="FMS predictive maintenance", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.predictor = predictor

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        rid = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        request.state.request_id = rid
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = rid
        return response

    def error(request: Request, status: int, code: str, message: str, details: list[dict[str, str]]) -> JSONResponse:
        meta = {"request_id": getattr(request.state, "request_id", None)}
        return JSONResponse({"error": {"code": code, "message": message, "details": details}, "meta": meta}, status_code=status)

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, exc: ServiceError):
        return error(request, exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, exc: RequestValidationError):
        details = [{"field": _field(tuple(e["loc"])), "reason": REASONS.get(e["type"], "invalid")} for e in exc.errors()]
        return error(request, 422, "VALIDATION_FAILED", "The request is invalid.", details)

    def authorized(request: Request) -> None:
        sent = request.headers.get(AUTH_HEADER, "")
        if not hmac.compare_digest(sent.encode(), settings.token.encode()):
            raise ServiceError(401, "AUTH_TOKEN_INVALID", f"A valid {AUTH_HEADER} is required.")

    def meta(request: Request) -> dict[str, Any]:
        return {"request_id": request.state.request_id, "model_version": predictor.version}

    def predictions(items: list[PredictRequest]) -> list[dict[str, Any]]:
        out = predictor.predict([item.features.model_dump() for item in items])
        return [{"vehicle_id": str(item.vehicle_id), "as_of": item.as_of.isoformat(), **p} for item, p in zip(items, out)]

    @app.get("/health")
    def health() -> dict[str, Any]:
        """Liveness, without a token: the model is loaded (the service does not start without one)."""
        return {"status": "ok", "model_version": predictor.version, "load_seconds": load_seconds}

    @app.get("/model", dependencies=[Depends(authorized)])
    def model_info(request: Request) -> dict[str, Any]:
        return {"data": predictor.describe(metrics), "meta": {"request_id": request.state.request_id}}

    @app.post("/internal/ml/predict-maintenance", dependencies=[Depends(authorized)])
    def predict(body: PredictRequest, request: Request) -> dict[str, Any]:
        return {"data": predictions([body])[0], "meta": meta(request)}

    @app.post("/internal/ml/predict-maintenance/batch", dependencies=[Depends(authorized)])
    def predict_batch(body: BatchRequest, request: Request) -> dict[str, Any]:
        return {"data": predictions(body.items), "meta": meta(request)}

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
