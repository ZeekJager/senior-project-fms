# Resilience drills (FMS-111)

Card FMS-111 (SE-155), architecture §28 (availability and failure handling), §41 Scenario F (an application server
fails) and §28.3 (an external service fails). Each dependency of the API is taken away while the API is in use, and
put back. What the API did, and how long it took to recover, are recorded here and checked in CI against the targets
below.

## Targets and outcomes

| Drill | What must happen while it is down | Recovered within | Outcome (measured) | Drill |
|---|---|---|---|---|
| **Redis stopped** | Every request answered. Rate limits count in each instance, sockets stay on their instance, events wait in the outbox. Readiness `200`, `checks.redis: "degraded"`. | 30 s after Redis is back | No request failed; reported degraded after 2 s; `ok` 3 s after restart | `check-resilience.sh` |
| **AI service stopped** | Every request answered. Maintenance scoring and trip risk wait (skipped, retried by the next run). Readiness `200`, `checks.ml: "degraded"`. | 60 s | No request failed; degraded after 5 s; `ok` 9 s after restart | `check-resilience.sh` |
| **Read replica stopped** | Every request answered, reports included: they read the primary. Readiness `200`, `checks.replica: "degraded"`. | 60 s | No request failed; degraded after 4 s; `ok` 2 s after restart | `check-resilience.sh` |
| **An API instance killed** (Scenario F) | Two instances behind the proxy: every request answered by the other one. One instance: down until it restarts; sessions survive (they are in the database). The web app says it is reconnecting. | 90 s to answer again | One instance: answering 24 s after it was killed. Two: 160 requests, none failed (FMS-106) | `check-resilience.sh`; `smoke-tls.sh` |
| **A provider fails** (§28.3) | Its breaker opens after 5 failures; calls then fail at once (`503 UPSTREAM_UNAVAILABLE`, `Retry-After`) and never wait on it; the rest of the API is not affected. | Its reset time, plus 1 s | Opened on the 5th failure; refused in under 500 ms; closed 1.0 s after the provider answered (reset time 1 s) | `resilience.test.ts` |
| **The primary database fails** | Writes refused with `503` and `Retry-After` for a few seconds, then go to the promoted standby; no GPS point lost. | 15 minutes (the DR target) | Service back in 7 to 9 s; 1,000 rows across it, all stored once | `check-failover.sh` ([disaster-recovery.md](disaster-recovery.md)) |

Measured on the development stack (Compose, one API instance) on 25 November 2026; CI repeats every drill on every push
and fails when one misses its target.

## The drills

`scripts/ci/check-resilience.sh` runs against a Compose stack that is up and migrated (CI's `resilience-drills` job):

```sh
FMS_API_URL=http://localhost:3000 FMS_DRILL_EMAIL=… FMS_DRILL_PASSWORD=… sh scripts/ci/check-resilience.sh --report report.md
```

- For Redis, the AI service and the read replica: the container is stopped for 20 s (`FMS_DRILL_OUTAGE_SECONDS`) and
  started again. Every second meanwhile, and until readiness says the dependency is `ok` again, it asks:
  - `GET /health/ready`: `200`;
  - `GET /api/v1/auth/me` without a session: `401` (the API routes, its rate limiter counts);
  - signed in as the drill's administrator: `GET /api/v1/vehicles` (the primary) and `GET /api/v1/analytics/fleet-summary`
    (the read replica, or the primary while it is down): `200`.
- For the API: the container is killed (`SIGKILL`) and started again; the time until readiness is `200` is the recovery
  time, and the session cookie from before must still work.
- It prints the table above with this run's numbers (the job summary in CI, and the `resilience-report` artifact), and
  exits 1 when a request failed, readiness never reported the outage, or recovery took longer than the target.
- Every container it stops is started again on exit, also when a drill fails.

The provider drill is `packages/backend/test/integration/resilience.test.ts` (backend-ci): a provider served locally starts
answering `502`, the breaker opens, and once it answers again the breaker closes on the first call after its reset time.

## What a user sees

- **Office screens and the driver app** show *Reconnecting…* above every page while the server is unavailable for a
  moment (`ReconnectingBanner`):
  - the database failing over (the API answers `503` with `Retry-After`): *The database is switching over…*;
  - the API not answering (no answer at all, or a `5xx` from the proxy rather than the API, which always answers JSON):
    *The server is not answering: it may be restarting, or this connection may be down…*.
  - It goes as soon as the API answers again. On the driver's phone it says that what they do is kept and sent later
    (the offline queue and the GPS buffer).
- **A dependency that is degraded** (Redis, the AI service, the replica) changes nothing on screen: requests are answered.
  Reports say *Data as of …* when the copy they read lags (FMS-94); predictions keep their last score until the next run.
- **A provider that is down** shows as *down* on Integrations, with when it will be tried again; the feature that uses it
  (a sync, a notification channel) fails or waits, nothing else does.

## Found while drilling

- `GET /health/ready` takes about a second while Redis is down: it waits for its Redis ping to time out. Other routes
  answer as fast as before (a few milliseconds), so no change was made; a monitor polling readiness should allow 2 s.
- **Redis down could stall new database connections** (seen twice in CI: readiness `503`, and a `GET /vehicles` with
  no answer in 5 s). Once the Redis container stops, Docker's DNS no longer knows `redis`, and each lookup of it takes
  about 4 s to fail. The API's 4 Redis clients (the main one, the Socket.IO adapter's two, the settings subscriber) keep
  looking it up to reconnect, and Node runs lookups on a pool of 4 threads, so they filled it. Every other lookup waited
  behind them, among them `db-proxy`'s when the pool opened a new database connection: readiness's `SELECT 1` passed its
  2 s, and a request that needed a new connection passed the probe's 5 s. A request on an open connection was answered
  in milliseconds, which is why it failed only now and then. Measured in the API container with the same 4 clients and a
  lookup of `db-proxy` every 500 ms while Redis was stopped:

  | Thread pool | Worst `db-proxy` lookup | Mean |
  |---|---|---|
  | 4 (Node's default) | 11.4 s | 6.7 s |
  | 16 | 1.2 s | 0.2 s |
  | 32 | 1 ms | 1 ms |

  Both backend images set `UV_THREADPOOL_SIZE=32` (`packages/backend/Dockerfile` and `Dockerfile.dev`). An API run
  outside Docker that should survive a Redis outage needs it too. The drill itself is the test.
- The web app treated only the database's `503` as a passing outage; an API that did not answer (a restart, a proxy's
  `502`) showed the screens' own error states as if final. It now shows *Reconnecting…* for that too (FMS-111).
