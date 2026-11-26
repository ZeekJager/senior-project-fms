"""
The predictive maintenance service (FMS-54, ADR-02): the trained model behind
an internal HTTP API, so the core never runs Python. docs/ml-service.md.

    uvicorn app:create_app --factory --host 0.0.0.0 --port 5000

Reads ML_SERVICE_TOKEN (required, at least 32 characters), ML_MODELS_DIR
(default ./models) and ML_MODEL_VERSION (default: the newest folder there).

The trip risk model (FMS-155, docs/ml-trip-risk.md) is optional: the newest tr-* folder
in ML_MODELS_DIR, or ML_TRIP_RISK_MODEL_VERSION. Without one, its endpoints say so.

The EV predictive maintenance model (FMS-135) is optional the same way: the newest pm-ev-*
folder, or ML_EV_MODEL_VERSION. GET /model?name= and the batch's ?model= choose between the
two; without the parameter, the combustion model, as before.
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
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest, multiprocess
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, create_model

from ml import artefact, error_tracking
from ml.ev.spec import load_spec as load_ev_spec
from ml.model import COMBUSTION, EV, Kind
from ml.serving import Predictor
from ml.spec import load_spec
from ml.trip_risk import serving as trip_risk
from ml.trip_risk.spec import load_spec as load_trip_risk_spec

ROOT = Path(__file__).resolve().parent
AUTH_HEADER = "X-Internal-Token"
REQUEST_ID_HEADER = "X-Request-Id"
MIN_TOKEN_LENGTH = 32
# One nightly scoring call scores this many vehicles at most (FMS-55 sends batches).
MAX_BATCH = 500
# One dispatch board asks for a depot's available drivers on one trip at once (FMS-155).
MAX_TRIP_RISK_BATCH = 200
# Seconds, the same buckets as the API's http_request_duration_seconds (FMS-75, docs/metrics.md).
LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10)
# Probes and the scrape itself say nothing about the service's users.
NOT_MEASURED = ("/health", "/metrics")


@dataclass(frozen=True)
class Settings:
    token: str
    models_dir: Path
    model_version: str | None = None
    trip_risk_version: str | None = None
    ev_model_version: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        shared_with_core = env.get("ML_SERVICE_TOKEN", "")
        return cls(
            shared_with_core,
            Path(env.get("ML_MODELS_DIR") or ROOT / "models"),
            env.get("ML_MODEL_VERSION") or None,
            env.get("ML_TRIP_RISK_MODEL_VERSION") or None,
            env.get("ML_EV_MODEL_VERSION") or None,
        )


def _newest(models_dir: Path, kind: Kind) -> Path | None:
    """The newest folder of a kind in ML_MODELS_DIR (pm-2026.10.2 after pm-2026.10); None without one."""
    if not models_dir.is_dir():
        return None
    versions = [p for p in models_dir.iterdir() if p.is_dir() and kind.version.match(p.name)]
    return max(versions, key=lambda p: tuple(int(n) for n in re.findall(r"\d+", p.name))) if versions else None


def ev_model_folder(settings: Settings) -> Path | None:
    """ML_EV_MODEL_VERSION's folder, or the newest pm-ev-* one (FMS-135); None: the service runs without an EV model."""
    if settings.ev_model_version:
        return settings.models_dir / settings.ev_model_version
    return _newest(settings.models_dir, EV)


def model_folder(settings: Settings) -> Path:
    """ML_MODEL_VERSION's folder, or the newest version in ML_MODELS_DIR (pm-2026.10.2 after pm-2026.10)."""
    if settings.model_version:
        return settings.models_dir / settings.model_version
    newest = _newest(settings.models_dir, COMBUSTION)
    if newest is None:
        raise RuntimeError(f"no model in {settings.models_dir}: run scripts/train.py, or set ML_MODELS_DIR")
    return newest


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


# The EV model's (feature_spec_ev.json, FMS-135), the same way: an EV's inputs never pass for a combustion vehicle's.
EvFeatures = create_model(
    "EvFeatures",
    __config__=ConfigDict(extra="forbid"),
    **{f["name"]: (int if f["type"] == "int" else float, Field(ge=f["min"], le=f["max"], strict=True)) for f in load_ev_spec()["features"]},
)


class EvPredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vehicle_id: uuid.UUID
    as_of: AwareDatetime
    features: EvFeatures  # type: ignore[valid-type]


class EvBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[EvPredictRequest] = Field(min_length=1, max_length=MAX_BATCH)


# The trip risk inputs (trip_risk_spec.json), the same way: every input required, within its range, nothing else.
TripRiskFeatures = create_model(
    "TripRiskFeatures",
    __config__=ConfigDict(extra="forbid"),
    **{
        f["name"]: (int if f["type"] == "int" else float, Field(ge=f["min"], le=f["max"], strict=True))
        for f in load_trip_risk_spec()["features"]
    },
)


class TripRiskItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trip_id: str = Field(min_length=1, max_length=64)
    driver_id: str = Field(min_length=1, max_length=64)
    features: TripRiskFeatures  # type: ignore[valid-type]


class TripRiskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[TripRiskItem] = Field(min_length=1, max_length=MAX_TRIP_RISK_BATCH)


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


class ServiceMetrics:
    """The service's metrics (FMS-75), in Prometheus' format.

    With several uvicorn workers (the production image runs two) each worker would count only the requests it served, and a scrape
    would reach a different one each time. When PROMETHEUS_MULTIPROC_DIR is set, the workers write to files in it and a scrape adds
    them up; the folder is emptied when the service starts (the image's command). Without it, one registry of this app.
    """

    def __init__(self, model_version: str, load_seconds: float) -> None:
        self.multiprocess = bool(os.environ.get("PROMETHEUS_MULTIPROC_DIR"))
        # In multiprocess mode the metrics live in files, not in a registry.
        self.registry = None if self.multiprocess else CollectorRegistry()
        self.requests = Histogram(
            "http_request_duration_seconds",
            "Request duration by method, route template and status class",
            ["method", "route", "status_class"],
            buckets=LATENCY_BUCKETS,
            registry=self.registry,
        )
        self.prediction = Histogram(
            "ml_prediction_duration_seconds", "Time to score one request's vehicles", buckets=LATENCY_BUCKETS, registry=self.registry
        )
        self.vehicles = Counter("ml_predicted_vehicles_total", "Vehicles scored", registry=self.registry)
        self.trip_risk = Counter("ml_trip_risk_predictions_total", "Drivers scored for a trip (FMS-155)", registry=self.registry)
        self.model = Gauge("ml_model_info", "1 for the model being served", ["version"], registry=self.registry, multiprocess_mode="max")
        self.model.labels(version=model_version).set(1)
        self.load = Gauge("ml_model_load_seconds", "Seconds the model took to load", registry=self.registry, multiprocess_mode="max")
        self.load.set(load_seconds)

    def render(self) -> bytes:
        if self.multiprocess:
            registry = CollectorRegistry()
            multiprocess.MultiProcessCollector(registry)
            return generate_latest(registry)
        return generate_latest(self.registry)


def route_template(request: Request) -> str:
    """The route a request matched, as its template (`/internal/ml/predict-maintenance/batch`), never its URL; strangers are one `unmatched` series."""
    path = getattr(request.scope.get("route"), "path", None)
    return path if isinstance(path, str) else "unmatched"


def create_app(settings: Settings | None = None) -> FastAPI:
    """Loads the model once, then serves it. Refuses to start without a usable token or model."""
    settings = settings or Settings.from_env()
    if len(settings.token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(f"ML_SERVICE_TOKEN must be at least {MIN_TOKEN_LENGTH} characters (run make env)")
    folder = model_folder(settings)
    started = time.perf_counter()
    predictor = Predictor.load(folder)
    _, metrics = artefact.read(folder)
    # Optional (FMS-135), but a folder that is there must be usable, as the trip risk model's.
    ev_folder = ev_model_folder(settings)
    ev_predictor = Predictor.load(ev_folder, EV) if ev_folder else None
    ev_metrics = artefact.read(ev_folder)[1] if ev_folder else None
    # Optional, but a folder that is there must be usable: a tampered or mismatched one stops the service as the other does.
    trip_folder = settings.models_dir / settings.trip_risk_version if settings.trip_risk_version else trip_risk.newest(settings.models_dir)
    trip_predictor = trip_risk.TripRiskPredictor.load(trip_folder) if trip_folder else None
    load_seconds = round(time.perf_counter() - started, 2)

    # Error tracking (FMS-109, docs/observability.md): off without SENTRY_DSN.
    error_tracking.init_error_tracking(os.environ.get("SENTRY_DSN") or None, os.environ.get("SENTRY_ENVIRONMENT", "development"))

    # No interactive docs: the API is internal, and documented in docs/api-contract.md §10.3.
    app = FastAPI(title="FMS predictive maintenance", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.predictor = predictor
    app.state.ev_predictor = ev_predictor
    app.state.trip_predictor = trip_predictor
    service_metrics = ServiceMetrics(predictor.version, load_seconds)
    app.state.metrics = service_metrics

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        rid = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        request.state.request_id = rid
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = rid
        return response

    @app.middleware("http")
    async def measure(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        if request.url.path not in NOT_MEASURED:
            service_metrics.requests.labels(
                method=request.method, route=route_template(request), status_class=f"{response.status_code // 100}xx"
            ).observe(time.perf_counter() - started)
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

    # Anything else is a 500 in the envelope, and goes to error tracking with its request id (FMS-109).
    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception):
        error_tracking.capture(exc, getattr(request.state, "request_id", None), route_template(request), request.method)
        return error(request, 500, "INTERNAL_SERVER_ERROR", "Something went wrong.", [])

    def authorized(request: Request) -> None:
        sent = request.headers.get(AUTH_HEADER, "")
        if not hmac.compare_digest(sent.encode(), settings.token.encode()):
            raise ServiceError(401, "AUTH_TOKEN_INVALID", f"A valid {AUTH_HEADER} is required.")

    def scrape_authorized(request: Request) -> None:
        """/metrics takes the internal token as the other endpoints do, or as a bearer token (what a Prometheus scrape sends)."""
        bearer = request.headers.get("Authorization", "")
        sent = request.headers.get(AUTH_HEADER) or (bearer[7:] if bearer.startswith("Bearer ") else "")
        if not hmac.compare_digest(sent.encode(), settings.token.encode()):
            raise ServiceError(401, "AUTH_TOKEN_INVALID", f"A valid {AUTH_HEADER} or bearer token is required.")

    def meta(request: Request, served: Predictor | None = None) -> dict[str, Any]:
        served = served or predictor
        return {"request_id": request.state.request_id, "model_name": served.name, "model_version": served.version}

    def maintenance_model(name: str | None) -> tuple[Predictor, dict[str, Any]]:
        """The model a request names (FMS-135): the combustion model by default, the EV model when the service has one."""
        if name in (None, "", COMBUSTION.name):
            return predictor, metrics
        if name == EV.name:
            if ev_predictor is None:
                raise ServiceError(404, "NOT_FOUND", "No EV predictive maintenance model is loaded.")
            return ev_predictor, ev_metrics  # type: ignore[return-value]
        raise ServiceError(404, "NOT_FOUND", f"No model named {name!r}.", [{"field": "model", "reason": "unknown_model"}])

    def predictions(items: list[Any], served: Predictor | None = None) -> list[dict[str, Any]]:
        served = served or predictor
        with service_metrics.prediction.time():
            out = served.predict([item.features.model_dump() for item in items])
        service_metrics.vehicles.inc(len(items))
        return [{"vehicle_id": str(item.vehicle_id), "as_of": item.as_of.isoformat(), **p} for item, p in zip(items, out)]

    @app.get("/health")
    def health() -> dict[str, Any]:
        """Liveness, without a token: the model is loaded (the service does not start without one)."""
        return {
            "status": "ok",
            "model_version": predictor.version,
            "ev_model_version": ev_predictor.version if ev_predictor else None,
            "trip_risk_model_version": trip_predictor.version if trip_predictor else None,
            "load_seconds": load_seconds,
        }

    @app.get("/metrics", dependencies=[Depends(scrape_authorized)])
    def scrape() -> Response:
        """Prometheus' text format (FMS-75, docs/metrics.md): internal, with the service's token."""
        return Response(service_metrics.render(), media_type=CONTENT_TYPE_LATEST, headers={"Cache-Control": "no-store"})

    @app.get("/model", dependencies=[Depends(authorized)])
    def model_info(request: Request, name: str | None = None) -> dict[str, Any]:
        """The model of that name serving now (FMS-135): the combustion model without one; 404 for an EV model the service lacks."""
        served, served_metrics = maintenance_model(name)
        return {"data": served.describe(served_metrics), "meta": {"request_id": request.state.request_id}}

    @app.get("/models", dependencies=[Depends(authorized)])
    def models_info(request: Request) -> dict[str, Any]:
        """Every predictive maintenance model the service serves, by name (FMS-135)."""
        served = [(predictor, metrics)] + ([(ev_predictor, ev_metrics)] if ev_predictor else [])
        return {"data": [p.describe(m) for p, m in served], "meta": {"request_id": request.state.request_id}}

    @app.post("/internal/ml/predict-maintenance", dependencies=[Depends(authorized)])
    def predict(body: PredictRequest, request: Request) -> dict[str, Any]:
        return {"data": predictions([body])[0], "meta": meta(request)}

    @app.post("/internal/ml/predict-maintenance/batch", dependencies=[Depends(authorized)])
    async def predict_batch(request: Request, model: str | None = None) -> dict[str, Any]:
        """
        A batch for the model named (FMS-135): the combustion model's inputs without `model`, the EV model's with
        model=predictive-maintenance-ev. Inputs of the other spec are refused as any invalid body (422).
        """
        served, _ = maintenance_model(model)
        schema = EvBatchRequest if served is ev_predictor and served is not None else BatchRequest
        try:
            raw = await request.json()
        except ValueError as e:
            raise RequestValidationError([{"loc": ("body",), "type": "json_invalid", "msg": str(e)}]) from e
        try:
            body = schema.model_validate(raw)
        except ValidationError as e:
            raise RequestValidationError(e.errors()) from e
        return {"data": predictions(body.items, served), "meta": meta(request, served)}

    def trip_model() -> trip_risk.TripRiskPredictor:
        if trip_predictor is None:
            raise ServiceError(404, "NOT_FOUND", "No trip risk model is loaded.")
        return trip_predictor

    @app.get("/models/trip-risk", dependencies=[Depends(authorized)])
    def trip_risk_model(request: Request) -> dict[str, Any]:
        """The trip risk model serving now (FMS-155), for the registry; 404 when the service runs without one."""
        return {"data": trip_model().describe(), "meta": {"request_id": request.state.request_id}}

    @app.post("/internal/ml/predict-trip-risk", dependencies=[Depends(authorized)])
    def predict_trip_risk(body: TripRiskRequest, request: Request) -> dict[str, Any]:
        """Each driver's chances on one trip, in the order asked (FMS-155)."""
        model = trip_model()
        with service_metrics.prediction.time():
            out = model.predict([item.features.model_dump() for item in body.items])
        service_metrics.trip_risk.inc(len(body.items))
        data = [{"trip_id": item.trip_id, "driver_id": item.driver_id, **p} for item, p in zip(body.items, out)]
        return {"data": data, "meta": {"request_id": request.state.request_id, "model_version": model.version}}

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
