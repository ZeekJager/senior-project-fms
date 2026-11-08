# Metrics and performance instrumentation (FMS-75)

Architecture §36 (observability) and §29 (performance): the system is measured against the CFG-3 budgets, so a regression is seen
before users feel it. The API, and the AI service, expose their numbers in **Prometheus' text format** at `GET /metrics`, on a port
of their own that is never the public one. A Prometheus (or any compatible scraper) collects them; nothing in the repository
stores or graphs them.

This is separate from the System health screen (docs/system-health.md, FMS-143): that one keeps minute samples in PostgreSQL for
an administrator to read in the app; these are for the operators' monitoring stack.

## Where they are

| Service | Address | Config |
|---|---|---|
| API | `http://<host>:9464/metrics` | `METRICS_PORT` (default 9464, `0` turns it off), `METRICS_HOST` (default `127.0.0.1`), `METRICS_TOKEN` |
| AI service | `http://ai-service:5000/metrics` | the same bearer token as its other endpoints (`ML_SERVICE_TOKEN`) |

**Not exposed publicly.** The API serves `/metrics` from a second, tiny HTTP server (`src/shared/metrics/metrics-server.ts`) that has no
other route, so nothing added to the public API can be reached through it, and `/metrics` on the public port is a 404. It listens on the
loopback unless `METRICS_HOST` says otherwise; in production, any other host requires `METRICS_TOKEN` (the configuration refuses to
start without it), sent as `Authorization: Bearer <token>` and compared in constant time. The Compose stack and the production images
publish no metrics port: a Prometheus on the same Docker network reaches `backend:9464`, nobody else does. Labels hold no ids, no
paths with ids, no query strings, no users.

## What the API exports

| Metric | Type | Meaning |
|---|---|---|
| `http_request_duration_seconds{method,route,status_class}` | histogram | Every API request. `route` is the matched template (`/api/v1/vehicles/:vehicleId/tracking`); a request no route matched is one `unmatched` series; health probes are left out. 13 buckets from 5 ms to 10 s |
| `outbox_oldest_pending_seconds` | gauge | The event outbox's lag (FMS-73): age of the oldest event not yet delivered |
| `outbox_undispatched_events`, `outbox_unpublished_events` | gauge | Events waiting for consumers, and for publication |
| `outbox_dead_lettered_events` | gauge | Events a consumer gave up on after every attempt: someone has to look |
| `replica_lag_seconds` | gauge | The read replica's lag (FMS-94); `-1` while there is none to measure |
| `replica_in_use`, `replica_fallbacks` | gauge | `1` while reporting reads use the replica; how many fell back to the primary |
| `circuit_breaker_state{provider}` | gauge | Each active provider's circuit on this instance (FMS-85): `0` closed, `1` half open, `2` open |
| `socket_connections` | gauge | Open Socket.IO connections on this instance (FMS-43) |
| `job_duration_seconds{job,status}` | histogram | Each scheduled job run, `succeeded` or `failed` |
| `web_vitals_*` | histogram | Core Web Vitals reported by the web app (below) |
| `process_*`, `nodejs_*` | | `prom-client`'s defaults: CPU, memory, event-loop lag, GC, handles |

Every series carries `service="fms-backend"`. The outbox, replica and circuit gauges are read at the scrape, all sources once and one
after the other (a scrape is a few small queries, at most once a second however many scrapers); a source that fails leaves its gauges
without a value and does not fail the scrape.

### Reading p95 per route

```promql
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
```

Per route and status class, or for one route: add `status_class` to the `by`, or filter `route="/api/v1/trips/:tripId"`. The CFG-3
budgets are the thresholds to alert on. An alert on the event outbox: `outbox_oldest_pending_seconds > 60` (what `/health/ready`
calls `degraded`) or `outbox_dead_lettered_events > 0`.

## Readiness

`GET /health/ready` covers the database (required), Redis, the event outbox and the read replica (reported, never a reason for 503),
and now the **AI service**: its own `GET /health`, kept for 5 seconds so a load balancer's polling does not become the AI service's
load. `checks.ml` is `ok`, `degraded` (down) or `disabled` (`ML_SERVICE_URL` not set).

By default a down AI service is only `degraded`: the API serves, and predictions wait. A deployment that cannot run without them sets
`READINESS_ML_CRITICAL=true`, and a down AI service then makes readiness `503` (`checks.ml: "failed"`), so the load balancer stops
sending traffic to the instance.

## Web vitals

The web app reports Core Web Vitals (LCP, INP, CLS, FCP, TTFB) of real users' sessions to `POST /telemetry/web-vitals`, which records
them as `web_vitals_*` histograms by metric name and rating. See below.

## pg_stat_statements

Enabled on the database (Compose: `shared_preload_libraries`; migration: `CREATE EXTENSION`), so the slowest and most frequent SQL is
visible: `SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;`. Reading it needs a
role that is a member of `pg_read_all_stats` (the application's role is not): use the admin role.
