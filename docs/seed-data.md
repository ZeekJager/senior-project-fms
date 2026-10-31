# Seed data

Card: FMS-113 (SE-157). Code: `packages/backend/scripts/seed.ts` and `packages/backend/scripts/seed/`.

Demo and test data that can be repeated, at the scale the performance budgets assume (CFG-3). UI work, demos and load tests all start from the same data.

## Running it

```bash
make seed                    # the small profile on the dev database, rebuilt first
make seed SIZE=budget        # 200 vehicles, 300 drivers, 1,000 trips

# Or directly, inside the backend container:
docker exec fms_backend npm run seed -- --size=small            # needs an empty database
docker exec fms_backend npm run seed -- --size=budget --reset   # rebuild the schema, then seed
docker exec fms_backend npm run seed -- --seed=7 --anchor=2026-10-01
docker exec fms_backend npm run seed:reset                      # rebuild the schema only
```

| Option | Default | Meaning |
|---|---|---|
| `--size` | `small` | `small` (a laptop demo) or `budget` (the performance-budget scale) |
| `--seed` | `20261007` | Seed for the random generator. The same seed gives the same data. |
| `--anchor` | today in Addis Ababa | The dataset's "today". Every date is relative to it: past trips, licence expiries, attendance. It cannot be in the future. |
| `--reset` | off | Rebuilds the schema first: every migration's Down in reverse, then every Up. |
| `--reset-only` | off | Rebuilds the schema and stops (`npm run seed:reset`). |

**`--reset` deletes all data in that database**, including the audit log: the audit schema is dropped with the rest. The audit log cannot be truncated, by design, so the reset rebuilds the schema instead. With local document storage (`STORAGE_DRIVER=local`) it also deletes the stored document files, which the rebuilt database no longer references. Files in an S3 bucket are left in place. Without `--reset`, the seed refuses to run on a database that holds any user or vehicle.

The seed and the reset **refuse to run when `NODE_ENV=production`**. The check runs before the config loads or any connection opens.

## What it creates

Counts that depend on the random draws are given for the default seed (20261007), with the range over ten other seeds in brackets.

| | small | budget |
|---|---|---|
| Depots | 3 | 8 |
| Staff accounts (admin, fleet manager, fleet owner, compliance officer; then dispatcher, depot admin, technician and finance clerk per depot) | 8 | 36 |
| Vehicles (12.5% / 8% electric), registered 4 to 6 years before the anchor (or new, when younger) | 24 | 200 |
| Drivers (each with an account) | 30 | 300 |
| Routes | 9 | 48 |
| Trips: draft, scheduled, assigned, en route, completed, cancelled | 80 | 1,000 |
| Fuel logs: one after each completed trip of a combustion vehicle, about 3% suspiciously high | 40 (27–43) | 526 (455–526) |
| Maintenance records: mostly completed, some open or scheduled, with parts used | 20 | 150 |
| GPS pings: a track for every completed trip, one every five minutes (below) | 6,184 | 70,800 |
| Service history: completed preventive work since each vehicle joined the fleet (below) | 147 (143–158) | 1,305 (1,282–1,310) |
| Spare parts: one shared catalogue; one low and one out of stock | 19 | 19 |
| Attendance | 3 days | the anchor day |
| Vehicle documents: an insurance certificate and a registration for every vehicle (one-page PDFs) | 48 | 400 |
| of which expire within 8–30 days of the anchor (amber) | 2 (2–10) | 28 (21–37) |
| of which expire within 0–7 days of the anchor (red) | 3 (1–5) | 18 (9–18) |

About 6% of licences are expired and 9% expire within 30 days, so the licence warnings have something to show. Drivers and vehicles are never double-booked, a driver only gets a vehicle their licence covers, and only while that licence is valid.

The vehicle documents do the same for document expiry: about 12% expire within 30 days (at least one amber and one red in every profile), none has already expired, and the rest run for 45 days to a year. Each upload is checked for expiry straight away (see [jobs.md](jobs.md)), and that check uses the real date. With the default anchor (today) the amber and red documents therefore raise their `DocumentExpiring` warnings during the seed. With an older `--anchor` the expiry dates move back with it, so fewer of them fall in the window.

## Service history

The predictive model (FMS-55, [ml-scoring.md](ml-scoring.md)) reads when each wearing part and fluid was last renewed. Without that history, the spec counts an item as never changed since the vehicle was built, so a seeded fleet looked worn out. Each vehicle therefore gets a believable history (`SERVICE_SCHEDULE` in `scripts/seed/catalog.ts`).

- **When it joined the fleet.** Each vehicle's `created_at` is 4 to 6 years before the anchor, or a few weeks after 1 January of its model year when it is younger. The API registers vehicles today, so the seed sets the date afterwards, audited.
- **The last time each item was done.** Seven kinds of planned work, each on a share of its usual interval before the anchor. Most work is on time (5% to 95% of the interval), and one in twenty is overdue (110% to 180%).

  | Work | Interval |
  |---|---|
  | Service: oil, oil filter, air filter | 4 months |
  | Fuel filter | 1 year |
  | Coolant and brake fluid | 2 years |
  | Brake pads, front and rear | 18 months |
  | Tyres, 4 of the vehicle's size | 4 years |
  | 12 V battery | 4 years |
  | Drive belt, gearbox oil and clutch fluid | 3 years |

- **Before it joined.** Work due before the vehicle joined the fleet is its original part, never changed in the system.
- **Electric vehicles** get no oil, fuel filter, belt, gearbox oil or clutch fluid work.
- **Records.** Each is a completed `preventive` record through the API, with its parts. It is drawn after everything else, so the rest of the plan is the same as before.
- **Odometer.** A repair reads the odometer the vehicle had that day. During the seeded trips that is its base reading plus the trips by then. Before them, the odometer runs back at the vehicle's average rate since it was built, so its readings only go up and none is suspect.
- **Stock.** The opening stock covers the history: what is left on the shelf is the stock drawn for the catalogue. Brake fluid, clutch fluid and gearbox oil are stocked parts now.

On the budget profile, scored by the model `pm-2026.10`, combustion vehicles average a health score of 86, and about 11% fall below 75. Electric vehicles score low: see [ml-scoring.md](ml-scoring.md#on-the-seeded-fleet).

## GPS tracks

Every completed trip has the GPS track a driver's phone would have reported (FMS-136), so the vehicle page can show the route each trip drove (`GET /vehicles/{vehicle_id}/tracking`). `scripts/seed/tracks.ts` draws it from the plan:

- **The road.** Each route follows its real road, measured with OSRM on OpenStreetMap and committed in `scripts/seed/roads.json` (FMS-84, [routing.md](routing.md)), the same for every trip on it. The route's distance is the road's length and its time that distance at 55 km/h; routes are saved with the road (`geometry`), so the maps draw it.
- **The trip.** A ping every five minutes from the trip's actual start to its actual end, from origin to destination. The speed drifts between 75% and 125% of the trip's average, and a trip over three hours stops once on the way for 15 to 30 minutes. The speeds add up to the trip's `actual_distance_km`.
- **As stored.** `source` is `phone` and there is no ignition reading, so the engine-hours job and the odometer readings ignore them. Each vehicle's current location (the live map) is where its last trip ended.
- **Repeatable.** The tracks use their own random generator, seeded by route and by trip, so they do not change anything else the plan draws.

## Signing in

The script prints one account per role (`seed.admin@fleet.demo`, then one per role, then the first driver). They all share one password: `FMS_SEED_PASSWORD` if set, otherwise a generated one, printed once at the end. The other accounts are invited, without a password (see [auth.md](auth.md), Creating a user).

## How it writes

Through the application's own HTTP API, served in the seed process on a loopback port: depots, users (`POST /users`, then the invitation link through `POST /auth/password`), vehicles, drivers, spare parts, maintenance, attendance and vehicle documents (`POST /documents`, multipart, into the configured document storage). Validation, business rules, audit entries and events all apply. Nothing reaches the database that the API would refuse.

Routes, trips and fuel logs have no API yet. They are inserted with `auditedMutation`, which writes the same audit entry a service would. GPS pings are inserted 5,000 to a statement with one `tracking.pings_ingested` audit entry each, as the ingestion audits a batch. Only the first admin is inserted directly, because the API needs someone to sign in as.

Then every read model is rebuilt (`rebuildReadModels()`), because those inserts publish no events. That includes the meter readings of the fuel logs and completed repairs (FMS-126). Each vehicle's registered odometer is a manual reading. Each completed repair reads the odometer the vehicle had on its date: its base reading plus the trips completed by then.

## Repeatable

`buildPlan(profile, seed, anchor)` (`scripts/seed/plan.ts`) turns the inputs into the whole dataset as plain data, with a seeded generator (mulberry32) and no clock. Running it with the same seed and anchor gives the same rows. The script prints a `fingerprint`: a SHA-256 of the business content of every seeded table. Two runs with the same seed and anchor print the same fingerprint.

GPS pings enter it per vehicle (count, first and last time, sums of position, speed and heading), not row by row. The fingerprint leaves out what differs on every run by design: ids, public ids, created/updated timestamps (except a vehicle's `created_at`, which the seed sets), password hashes (salted) and audit correlation ids. Other values derived from the current time are also left out (for example a repair's `started_at`).

## Where it is tested

- `scripts/seed/plan.test.ts` (unit): same plan for the same inputs; the budget counts; every role and trip status; unique keys; no double booking; licence and odometer rules; registration dates and the service history (every item renewed on most vehicles, no work before a vehicle joined, odometers that only go up); opening stock covering every repair; two documents per vehicle with amber and red ones; the placeholder PDF; the production guard.
- `test/integration/seed.test.ts`: the small profile on the test database, audited (vehicle documents included), then a second run with the same fingerprint.
- CI (`migrations-ci` job): the budget profile twice on a fresh database, `200/300/1000` rows, equal fingerprints, and a refused run with `NODE_ENV=production`.
