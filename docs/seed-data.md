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
| Vehicles (12.5% / 8% electric) | 24 | 200 |
| Drivers (each with an account) | 30 | 300 |
| Routes | 9 | 48 |
| Trips: draft, scheduled, assigned, en route, completed, cancelled | 80 | 1,000 |
| Fuel logs: one after each completed trip of a combustion vehicle, about 3% suspiciously high | 40 (27–43) | 526 (455–526) |
| Maintenance records: mostly completed, some open or scheduled, with parts used | 20 | 150 |
| Spare parts: one shared catalogue; one low and one out of stock | 16 | 16 |
| Attendance | 3 days | the anchor day |
| Vehicle documents: an insurance certificate and a registration for every vehicle (one-page PDFs) | 48 | 400 |
| of which expire within 8–30 days of the anchor (amber) | 2 (2–10) | 28 (21–37) |
| of which expire within 0–7 days of the anchor (red) | 3 (1–5) | 18 (9–18) |

About 6% of licences are expired and 9% expire within 30 days, so the licence warnings have something to show. Drivers and vehicles are never double-booked, a driver only gets a vehicle their licence covers, and only while that licence is valid.

The vehicle documents do the same for document expiry: about 12% expire within 30 days (at least one amber and one red in every profile), none has already expired, and the rest run for 45 days to a year. Each upload is checked for expiry straight away (see [jobs.md](jobs.md)), and that check uses the real date. With the default anchor (today) the amber and red documents therefore raise their `DocumentExpiring` warnings during the seed. With an older `--anchor` the expiry dates move back with it, so fewer of them fall in the window.

## Signing in

The script prints one account per role (`seed.admin@fleet.demo`, then one per role, then the first driver). They all share one password: `FMS_SEED_PASSWORD` if set, otherwise a generated one, printed once at the end. The other accounts are invited, without a password (see [auth.md](auth.md), Creating a user).

## How it writes

Through the application's own HTTP API, served in the seed process on a loopback port: depots, users (`POST /users`, then the invitation link through `POST /auth/password`), vehicles, drivers, spare parts, maintenance, attendance and vehicle documents (`POST /documents`, multipart, into the configured document storage). Validation, business rules, audit entries and events all apply. Nothing reaches the database that the API would refuse.

Routes, trips and fuel logs have no API yet. They are inserted with `auditedMutation`, which writes the same audit entry a service would. Only the first admin is inserted directly, because the API needs someone to sign in as.

## Repeatable

`buildPlan(profile, seed, anchor)` (`scripts/seed/plan.ts`) turns the inputs into the whole dataset as plain data, with a seeded generator (mulberry32) and no clock. Running it with the same seed and anchor gives the same rows. The script prints a `fingerprint`: a SHA-256 of the business content of every seeded table. Two runs with the same seed and anchor print the same fingerprint.

The fingerprint leaves out what differs on every run by design: ids, public ids, created/updated timestamps, password hashes (salted) and audit correlation ids. Other values derived from the current time are also left out (for example a repair's `started_at`).

## Where it is tested

- `scripts/seed/plan.test.ts` (unit): same plan for the same inputs; the budget counts; every role and trip status; unique keys; no double booking; licence and odometer rules; two documents per vehicle with amber and red ones; the placeholder PDF; the production guard.
- `test/integration/seed.test.ts`: the small profile on the test database, audited (vehicle documents included), then a second run with the same fingerprint.
- CI (`migrations-ci` job): the budget profile twice on a fresh database, `200/300/1000` rows, equal fingerprints, and a refused run with `NODE_ENV=production`.
