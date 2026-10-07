# Fleet Management System - Complete PostgreSQL Migration Set

This directory is the **replacement PostgreSQL baseline** for the Fleet Management System database architecture.

## Architecture mapping

| Migration | PostgreSQL schema(s) | Architectural responsibility |
|---|---|---|
| 001 | `shared`, `auth` | Shared types, identity, JWT session support, RBAC |
| 002 | `fleet` | Depots, vehicles, drivers, assignments, attendance, DVIR |
| 003 | `trip` | Routes, trips, stops |
| 004 | `fuel` | Fuel logs and fuel anomalies |
| 005 | `maintenance` | Maintenance, inventory, inventory movements, ML predictions |
| 006 | `integration` | GPS devices, external providers, synchronization, fuel-card integration |
| 007 | `tracking` | Current location, historical GPS pings, telemetry flags |
| 008 | `alert` | Alerts, acknowledgement, notifications, incidents |
| 009 | `ev` | Battery telemetry, charging stations, charging sessions |
| 010 | `audit` | Append-only audit logging |
| 011 | `analytics` | Performance indexes and reporting/read views |
| 012 | `document`, `api` (+ cross-cutting) | API-contract alignment: public UUIDs, documents, idempotency keys, trip overlap constraints, telemetry de-duplication |
| 013 | (grants) | Runtime privileges for the `fms_app` role; audit table stays INSERT/SELECT only |
| 014 | `auth` | Session families on `refresh_sessions` for refresh-token rotation and reuse detection (FMS-05) |

## Important

This set is designed for a **new PostgreSQL database** and intentionally supersedes the earlier `public.*` implementation and the MySQL `schema-fms.sql` file.

The bundle in `bundle/fms_install_all.sql` is the concatenated Up sections for a one-shot install; regenerate it whenever a migration changes.

Do **not** run these migrations on top of the old `public.*` tables without first performing a data migration.

## Database technology

- PostgreSQL
- Transactional system of record: PostgreSQL
- Cache / Pub/Sub: Redis (outside this SQL migration set)
- Read scaling: PostgreSQL streaming/read replica (deployment concern, outside this SQL migration set)
- ORM: Prisma or Sequelize

## Design notes

- **Depot scoping.** `auth.users.depot_id` is the single source of a user's home depot (NULL = depot-unscoped, e.g. admin). A driver's depot is their user's depot; `fleet.drivers` keeps no copy, so the two cannot drift. `GET /drivers?depotId=` joins through `auth.users`.
- **Cross-module foreign keys** are added by the migration that creates the *referenced* table and dropped first in its Down: `fk_users_depot` in 002, `fk_dvir_trip` in 003.
- **Trip lifecycle.** A trip is created with route + schedule and assigned a driver and vehicle later. `chk_trip_assignment` requires both from `assigned` onward; `chk_trip_schedule_required` requires times outside `draft`/`cancelled`.
- **Optimistic locking.** `trip.trips.version` is bumped by a trigger on every UPDATE. Write with `UPDATE ... WHERE id = $1 AND version = $2`; 0 rows updated means a concurrent edit.
- **Soft delete.** `auth.users.is_active` is generated from `status` (deactivate by setting `status`). Other core tables keep a plain `is_active`.
- **Integer-only fuel/money/speed.** ml, cents, ml/km and km/h are integers. Note that Postgres rounds a numeric *literal* into an integer column; a value sent as a query parameter (`'1.5'`) is rejected. The API must still reject floats itself (`VALIDATION_FLOAT_IN_MONEY_PATH`).
- **Audit.** `audit.audit_logs` rejects UPDATE/DELETE/TRUNCATE for every role (triggers) and the app role only has INSERT/SELECT (012). `correlation_id` is the uuid returned as `correlationId` in API errors.
- **Notifications.** `alert.notifications` doubles as the in-app inbox: an `in_app` row is the inbox entry and `read_at` marks it read. `alert_id` is optional for non-alert notifications.
- **Public identifiers.** Every table the API exposes has `public_id UUID` (012). Foreign keys and joins use the BIGINT `id`; the API only ever exposes `public_id`.
- **Refresh sessions.** `auth.refresh_sessions.token_hash` is the SHA-256 of the refresh token, never the token. Every login starts a `family_id`; a refresh revokes the used row and inserts the next one in the same family, and a revoked token presented again revokes the whole family (see docs/auth.md).
- **Permissions** are the contract's `resource:action` codes, seeded in 001. The role seed raises an error on any unknown code, so a typo cannot silently drop a grant.
- **Trip overlap** is enforced by exclusion constraints (`ex_trip_driver_overlap`, `ex_trip_vehicle_overlap`, SQLSTATE 23P01) on trips in `assigned`/`en_route`. Requires the `btree_gist` extension.
- **Telemetry retries**: `tracking.gps_pings` is unique on `(vehicle_id, recorded_at)`; insert with `ON CONFLICT DO NOTHING`.
- **Analytics cache.** `analytics.analytics_cache` is derived data, upserted on `(vehicle_id, period_type, period_start)` by a scheduled job.

## Upgrading an existing database

`make migrate` records each applied file name in `schema_migrations` and skips it next time. The earlier `public.*` baseline used the same file names (`001_core_identity.sql`, ...) with different contents, so a database created from it would skip the new `001` and keep the old tables. This set is a replacement baseline for a **new** database: run `make clean` (drops the docker volume) and then `make dev` and `make migrate`. If the old tables hold data you need, migrate it first.

## Module boundaries

The PostgreSQL schemas are aligned with the modular-monolith boundaries:

```text
shared.*
  └── common database primitives

auth.*
  └── identity / RBAC

fleet.*
  └── driver / vehicle / depot operations

trip.*
  └── routes / trips / stops

fuel.*
  └── fuel records / anomalies

maintenance.*
  └── maintenance / parts / predictive maintenance

integration.*
  └── external adapters / telemetry device registry

tracking.*
  └── GPS / current location / telemetry flags

alert.*
  └── alerts / notifications / incidents

ev.*
  └── EV battery / charging

audit.*
  └── immutable audit history

analytics.*
  └── reporting projections / read views
```

## Notes on application ownership

A shared PostgreSQL deployment does not mean modules should query each other's tables arbitrarily. The Node.js modular monolith should enforce module ownership at repository/service boundaries.

Examples:

- Trip logic uses the Trip repository and a defined Vehicle/Driver application interface rather than issuing arbitrary SQL against `fleet.*` tables.
- Alert logic may reference source events from other modules using `source_module`, `source_event_type`, and `source_record_id`, because that is a polymorphic reference and cannot be represented by one normal foreign key.
- Predictive maintenance is calculated by the separate Python/FastAPI service; prediction results are persisted in `maintenance.maintenance_predictions` by the core application.

## High-volume tracking

`tracking.gps_pings` is range-partitioned by `recorded_at` and currently has a `DEFAULT` partition. When data volume warrants it, monthly partitions can be added and data moved out of the default partition.

## Backup / recovery

The database architecture expects:

- nightly full backups
- continuous WAL archiving
- encrypted backup storage
- tested restore procedures
- a PostgreSQL read replica for analytics/read-heavy workloads

Exact RPO/RTO values should come from the final SRS.

## Migration runner

The files use the same `-- +migrate Up` / `-- +migrate Down` markers as the previous migration set. Run them in numeric order.
