# Presentation runbook

How to start FMS for a live demo, what to show and in what order, and what to do if something goes wrong. For the
narrated 12-minute Golden Path see [DEFENCE_NOTES.md](DEFENCE_NOTES.md); for every screen see the
[User Guide](USER_GUIDE.md).

## 1. Before the audience arrives (about 10 minutes)

Docker Desktop must be running. From the repository root, on the `demo/presentation` branch (it includes the dev-proxy
fix, without which every Save in the browser is refused):

```bash
make dev-bg                # build and start everything (first build takes several minutes)
make migrate               # create the database tables
make demo                  # 50 vehicles, 60 drivers, 160 trips, 3 depots; every account's password is password1234
make demo-sim              # drive all 50 vehicles, one GPS ping each every 2 seconds
make demo-web              # the fast web app on port 8081 (a few minutes to build the first time)
```

Present from **<http://localhost:8081>**: it is the production build served by nginx and loads in milliseconds. The
development server on port 5173 (started by `make dev-bg`) takes about 4 seconds to load a page and is only the
fallback. `make demo-web` builds the current code, so run it again after any change to the web app.

`make demo` deletes everything in the development database first. `.env` is created by `make env`; for the 2-second
live map set `TRACKING_EVENT_INTERVAL_SECONDS=2` in it (the Compose file passes it to the backend) and restart the
backend if you change it: `docker compose up -d backend`.

Check that it works:

| What | Where | Expect |
| --- | --- | --- |
| The app | <http://localhost:8081> | the sign-in page, instantly |
| The app, fallback | <http://localhost:5173> | the same, slower |
| Readiness | <http://localhost:3000/health/ready> | `"status":"ok"`, every check `ok` |
| API documentation | <http://localhost:3000/api-docs> | Swagger UI |

Sign in as `seed.admin@fleet.demo` / `password1234`, open **Command center**: 50 vehicles should be moving on the map.
Stop the movement with `make demo-sim-stop`, start it again with `make demo-sim`.

## 2. Accounts

Every account signs in with **`password1234`**. The eye at the right end of the password field shows what you typed.

| Role | Email | Depot |
| --- | --- | --- |
| Administrator | `seed.admin@fleet.demo` | all |
| Administrator | `meron.desta@fleet.demo` | all |
| Fleet manager | `almaz.negash@fleet.demo` | all |
| Fleet owner | `zewdu.lemma@fleet.demo` | all |
| Compliance officer | `feven.yohannes@fleet.demo` | all |
| Dispatcher | `kebede.kassa@fleet.demo` | ADD-01 Addis Ababa Central |
| Depot admin | `senait.negash@fleet.demo` | ADD-01 |
| Technician | `tadesse.wolde@fleet.demo` | ADD-01 |
| Finance clerk | `biniam.kassa@fleet.demo` | ADD-01 |
| Driver | `yonas.negash@fleet.demo` | ADD-01 |

Other depots: ADM-01 Adama Logistics Hub (dispatcher `tigist.belay`, depot admin `tsion.tadesse`) and HWS-01 Hawassa
Depot (dispatcher `solomon.haile`, depot admin `mahlet.haile`), all at `@fleet.demo`. Use separate browser profiles or
private windows to be signed in as two roles at once.

## 3. Suggested order (15 to 20 minutes)

1. **Sign in** as the administrator. Show the password eye. (30 s)
2. **Command center**: 50 vehicles moving, a position every 2 seconds. Select a vehicle for its speed, trip and
   driver. This is real: positions arrive at the API like a tracker's would, are stored, and are pushed to the browser.
3. **Fleet management**: vehicles, drivers, maintenance, fuel, reports. Filter and open one vehicle.
4. **Golden Path** with two windows (dispatcher and driver, then technician), following the ten steps of
   [DEFENCE_NOTES.md](DEFENCE_NOTES.md#the-golden-path-demo). Plates and driver names differ from that script, which was
   written for the smaller seed: pick any free driver and van of ADD-01 on **Dispatch**.
5. **Administration**: users, audit log, system health, telematics.
6. **Behind the scenes**: Swagger UI at `/api-docs`; `docs/security.md` (CSRF, rate limits, headers) and
   `docs/driver-data-protection.md` (driver data encrypted at rest, retention) in one sentence each.

## 4. If something goes wrong

| Symptom | Fix |
| --- | --- |
| Sign-in says invalid credentials | the password is `password1234`; if the data was seeded differently run `make demo` again |
| Saving anything fails with a 403 | on port 5173: you are not on the `demo/presentation` branch (Vite proxy); switch and `docker compose restart frontend`. Port 8081 is not affected |
| Map empty or still | `make demo-sim`; check `docker exec fms_backend pgrep -af simulate` |
| Map moves slowly | `TRACKING_EVENT_INTERVAL_SECONDS=2` in `.env`, then `docker compose up -d backend` |
| Page will not load | `docker ps`: all six containers up and `fms_frontend_prod`; if it is missing, `make demo-web`; `docker compose logs --tail 50 backend frontend` |
| Everything is broken | `make clean && make dev-bg`, wait for the build, then `make migrate demo demo-sim demo-web` |

Offline fallback: the User Guide has screenshots of the whole Golden Path.

## 5. What is not there

- The Golden Path is automated at the API level, not through the browser:
  `docker exec -e NODE_ENV=test fms_backend npx vitest run --project integration test/integration/golden-path.test.ts`
  (about a minute). The screens are rehearsed by hand.
- The demo password is for a presentation only. The seed refuses to run when `NODE_ENV=production`.
