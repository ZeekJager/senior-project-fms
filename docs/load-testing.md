# Load testing suite (FMS-61)

Card: FMS-61 (SE-97). Code: `packages/backend/scripts/load/`. CI job: `load-test` ([ci.md](ci.md)).

The suite proves the system holds the load of a live demo and of the fleet the budgets assume, before the defence: 200 vehicles
reporting while people watch the live map, 50 people working the API, 20 opening the dashboards at once. Every run builds its own
database, starts the API as production runs it, measures, writes a JSON report and fails when a budget is missed.

```bash
npm run build -w fms-backend
npm run load-test -w fms-backend                                  # the card's workload, about 12 minutes
npm run load-test -w fms-backend -- --profile smoke               # the same scenarios briefly, about 6 minutes
npm run load-test -w fms-backend -- --only gps,dashboard          # some scenarios
npm run load-test -w fms-backend -- --reuse-db --profile smoke    # development: keep the last run's database, skip the seed
```

It needs PostgreSQL and Redis, as the integration tests do ([testing.md](testing.md)): `DB_HOST`, `DB_PORT`, `DB_ADMIN_PASSWORD`,
`DB_PASSWORD` (or `DB_APP_PASSWORD`), `REDIS_HOST`, `REDIS_PASSWORD`, from the environment or the repository's `.env`. The dev
stack's Redis is not published to the host, so run one for the suite:

```bash
docker run -d --name fms-load-redis -p 127.0.0.1:6391:6379 redis:7.4-alpine redis-server --requirepass "$REDIS_PASSWORD"
REDIS_HOST=localhost REDIS_PORT=6391 npm run load-test -w fms-backend
```

## What a run does

1. **Database.** Drops and recreates `LOAD_DB_NAME` (default `fms_load_test`), applies every migration, and seeds the budget dataset
   ([seed-data.md](seed-data.md): 200 vehicles, 300 drivers, 1,000 trips with their fuel, repairs and GPS history), in about 3 minutes.
   - **Never production:** it refuses `NODE_ENV=production` and any database name not ending in `_test`.
   - **Accounts:** it creates its own fleet managers (`load-<run>-NN@load.test`), sharing one password made for the run, never
     printed or stored.
   - **Devices:** one tracker with a token per vehicle, as the GPS simulator's `--via device` does.
   - **Keys:** without a `JWT_SECRET` or `DATA_ENCRYPTION_KEY`, keys made for the run; the database is new each time.
2. **The API.** The compiled server (`dist/src/server.js`, what the production image runs) in its own process with
   `NODE_ENV=production`: Redis, the outbox relay, the Socket.IO gateway and the scheduler as in production. Its log goes beside the
   report. Its differences from production:
   - The per-address limits (sign-in, the address ceiling, anonymous requests) are raised: every client of the run is on one
     machine, and they would count all 50 users as one person. The per-session and per-device limits are production's.
   - `TRUST_PROXY=0`: there is no proxy in front.
   - No backups: it is given neither the schema owner's credentials (the runner's, for creating the database; the API connects as
     the app role) nor a backup role's, so the scheduler's backup ([backups.md](backups.md)) cannot fire a `pg_dump` mid-scenario.
3. **Drain.** The seed leaves its domain events in the outbox (about 4,300). The API's relay delivers them first, about a minute.
   The suite waits for that: a position event waiting behind them more than 30 seconds is dropped by design ([realtime.md](realtime.md)),
   which would count as a drop the load did not cause.
4. **The scenarios**, one after another, each with the API's CPU and event-loop lag sampled every 5 seconds from its own metrics
   port ([metrics.md](metrics.md)). Reading the server's own counters keeps the load generator's CPU out of them.
5. **The report** (`packages/backend/load-report/<profile>.json`) and a line per budget on the console. The exit code is 1 if any
   budget is missed.

## The scenarios

| | Workload (`full`) | `smoke` |
|---|---|---|
| 1. GPS and live map | 200 vehicles post a ping every 10 s for 5 minutes, each with its own device token (`POST /tracking/gps-pings`), spread over the interval as real devices are; 25 signed-in dashboards hold a socket | 50 vehicles, 30 s, 5 dashboards |
| 2. API | 50 users for 2 minutes, each: list trips (40%), list vehicles (40%) or log a fill-up for their own vehicle (20%), then pause 0.5 to 1.5 s | 10 users, 20 s |
| 3. Dashboards | 20 users for a minute, each opening the Fleet Command Center (S-16) and the analytics dashboard (S-18) in turn, then pausing 1 to 3 s | 5 users, 15 s |

- **Scenario 1, what is measured.** Every ping accepted becomes the vehicle's position and is announced as `vehicle.location.updated`
  ([gps-ingestion.md](gps-ingestion.md)). Every dashboard socket must receive every one: a missing one is a dropped event. Delivery
  latency runs from sending the ping to a dashboard receiving it, both on the load generator's clock, so it covers the whole path:
  ingestion, the outbox, the relay's 200 ms poll, Redis and the gateway.
- **Why devices, not the socket.** The card describes vehicles sending `location_update` over Socket.IO. That event is the legacy path,
  off unless `REALTIME_LEGACY_LOCATION=true` ([realtime.md](realtime.md)); trackers and providers report over REST. The suite loads
  the path production uses, and the 25 dashboards carry the concurrent sockets.
- **Scenario 3, a page.** A page makes its requests together, as the browser does: the Command Center its overview and the vehicles'
  current positions; the analytics dashboard its three reports over the default 30 days. It counts as loaded when the last answers:
  when its first meaningful data can be drawn.
- **Warm-up.** In scenarios 2 and 3, every user first does each action once, all at the same moment, before the timed window. A
  server just started answers its first requests from cold caches and connections; with a short smoke run, one cold request would
  be its p95. The warm-up's numbers are in the report (`warmup`), not held to the budgets. Its failures still fail the run.

## Budgets

A run fails if any is missed. The p95s are nearest-rank, per request label.

| Budget | Limit | Source |
|---|---|---|
| Socket events dropped | 0 | the card |
| Position delivered to a dashboard, p95 | under 500 ms | engineering spec §4 (GPS update latency) |
| API process CPU, p95 of 5 s samples | under 80% of one core | the card |
| `GET /trips`, p95 | under 200 ms | the card |
| `GET /vehicles`, p95 | under 500 ms | SRS NFR-2 |
| `POST /fuel-logs`, p95 | under 400 ms | the card |
| A page loaded, p95 | under 2 s | the card (first meaningful data) |
| Each analytics report, p95 | under 200 ms | the card (the analytics cache) |
| Failed requests, dashboard disconnects | 0 | every scenario |

The budgets are in `scripts/load/profiles.ts`; the checks in `scripts/load/report.ts`. A budget with nothing measured against it
fails rather than passing by default.

## Results

The `full` profile on a development laptop (Intel i5-10300H, 8 threads, 40 GB; Windows 11, Node 25; PostgreSQL 16 and Redis 7.4 in
Docker on the same machine), 11 November 2026, the budget dataset freshly seeded. Every budget met.

| Scenario | Measured | p50 | p95 | p99 | Budget |
|---|---|---|---|---|---|
| 1. GPS | 5,996 pings, 149,900 deliveries (5,996 × 25 dashboards), 0 dropped, 0 disconnects | | | | 0 dropped |
| | Ping to dashboard | 244 ms | **461 ms** | 655 ms | < 500 ms |
| | `POST /tracking/gps-pings` (20 a second) | 14 ms | 28 ms | 51 ms | |
| | API CPU (61 samples) | 18% | **24%** | 26% | < 80% |
| 2. API | `GET /trips` (2,331, 19 a second) | 12 ms | **28 ms** | 126 ms | < 200 ms |
| | `GET /vehicles` (2,325) | 12 ms | **28 ms** | 100 ms | < 500 ms |
| | `POST /fuel-logs` (1,214, 10 a second) | 25 ms | **54 ms** | 171 ms | < 400 ms |
| | API CPU | 32% | 41% | | |
| 3. Dashboards | Fleet Command Center (310 openings) | 11 ms | **41 ms** | 154 ms | < 2 s |
| | Analytics dashboard (310) | 10 ms | **36 ms** | 134 ms | < 2 s |
| | Slowest analytics report (`maintenance-risk`) | 9 ms | **35 ms** | 133 ms | < 200 ms |

No request failed in any scenario, warm-up included. The event loop's lag stayed under 26 ms (p99, every sample).

- **The tightest margin is delivery to the live map**, 461 ms against 500. It is not the API's capacity: ingestion answers in 28 ms
  and the CPU stays under a quarter of a core. It is the outbox ([events.md](events.md)): the relay publishes to Redis once a pass,
  then runs the in-process consumers for the same events, then sleeps 200 ms. A ping committed just after a pass has published
  waits for the rest of that pass and the sleep, so most of the 244 ms median is waiting. It is the budget to watch on a slower
  machine; the relay's interval (`pollIntervalMs`) is the lever if it is ever missed.
- **The first request is the slow one.** In the warm-up, each user's first action, all at once on a server just started, took
  60 to 490 ms (p95: trips 305 ms, vehicles 313 ms, a fill-up 488 ms; a page 290 to 670 ms): connections being opened and caches
  filled. That would miss the trips, fuel-log and analytics budgets, which are about steady load; it is why the warm-up is reported
  but not scored. A demo's first page after a restart is that case, and still well under the 2 s a page is allowed.

## The report

`load-report/<profile>.json` (ignored by git; CI keeps the folder as the `load-report` artifact for 30 days):

- `passed`, `checks` (each budget: actual, limit, passed);
- `machine` (Node, CPU, cores, memory), `commit`, `dataset` (how big the seeded data was), `server` (the raised limits);
- `results.gps`: the ping requests, `events` (`announced`, `expected` = announced × dashboards, `received`, `dropped`,
  `observerDisconnects`, `unmatched`: events that matched no ping sent, which would point at a matching fault rather than a drop),
  `deliveryMs`;
- `results.api` and `results.dashboard`: per request label count, mean, p50, p95, p99, max and rate, `warmup`, errors by outcome;
- each scenario's `server`: CPU (% of one core) and event-loop lag p99 per sample.

`load-report/<profile>-server.log` is the API's log for the run.

## Tests

`scripts/load/load.test.ts` (unit): percentiles and summaries, the budget checks (a dropped event, a slow endpoint or one failed
request fails; nothing measured fails), reading Prometheus samples with labels, CPU from two readings, the session's cookies, the
dashboards' requests and range, and the guard.
