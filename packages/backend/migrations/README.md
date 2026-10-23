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
| 015 | `fleet` | `drivers.license_categories TEXT[]` of European licence categories (AM ... DE), replacing the free-text `license_category` (FMS-16) |
| 016 | `fleet` | `version` on `vehicles` and `drivers`, bumped by trigger, for optimistic concurrency (If-Match / ETag) (FMS-16) |
| 017 | `fleet` | `driver_accounts`: the fleet module's copy of drivers' name, email, depot and account status, so the driver list filters and sorts in one query (FMS-16) |
| 018 | `document` | `documents.expires_on`: a document's own expiry date (registration, licence, insurance), indexed for live documents, for expiry warnings (FMS-17) |
| 019 | `fleet`, `auth` | `depots.version` (If-Match on depot writes) and upper-case depot codes; `depot:write` moves from fleet_manager to fleet_owner (FMS-20) |
| 020 | `maintenance` | `maintenance_records.version` (If-Match) and `completed_by` (FMS-22) |
| 021 | `maintenance` | `inventory_parts.version` (If-Match), upper-case part numbers, partial index for below-reorder parts (FMS-23) |
| 022 | `auth` | `password_tokens`: one-time password setup and reset links, SHA-256 of the token only (FMS-78) |
| 023 | `jobs`, `fleet` | `jobs.job_runs`: the scheduler's per-day lock and run history; `fleet.expiry_notices`: each document or licence expiry warning raised once per level (FMS-26) |
| 024 | `audit` | `audit_logs.request_source` (channel, IP, user agent; system actor for jobs) and `result` (success, denied, failed), required on new rows (NOT VALID checks; old rows untouched) (FMS-27) |
| 025 | `audit`, `auth` | Indexes for the audit reader (newest first on `created_at, id`; entity public id); `audit:read` taken from fleet_manager (admin, fleet owner, compliance officer keep it) (FMS-28) |
| 026 | `events` | Domain events (FMS-73): `events.outbox`, written in the change's transaction and delivered by the relay (dispatched to consumers, published on Redis; retries and dead letters); `events.processed_events`, each event a consumer has handled. Platform-owned, like `api` and `jobs` |
| 029 | `fleet`, `shared`, `analytics` | Vehicle status and availability (FMS-76): `shared.vehicle_status` without the legacy `decommissioned` (type replaced, `analytics.vehicle_current_status` re-created); `fleet.vehicle_status_history`, each status change with its reason, who, and its source (a person, or maintenance work starting and ending); `fleet.trip_assignments`, the read model of trips holding a vehicle or driver, kept by a projection in each trip change's transaction |
| 030 | `trip` | Trip assignment rules (FMS-31): `ex_trip_driver_overlap` and `ex_trip_vehicle_overlap` include both ends (`'[]'`), so a 0-minute gap between two trips is an overlap |
| 031 | `integration` | Integration gateway (FMS-85): `external_providers.code`, the provider's slug in webhook URLs and secret names (secrets stay in the environment); inbound `sync_logs` unique on `(provider_id, external_reference)`, so a redelivered webhook is a duplicate; index for a provider's running sync |
| 032 | `integration`, `tracking` | GPS ingestion (FMS-88): `gps_devices.public_id` and a device token (its SHA-256 only), so a device reports for its own vehicle; `vehicle_current_location.event_recorded_at`, the last position announced as `VehicleLocationUpdated`, which throttles the event per vehicle across instances |
| 033 | `alert` | Alert engine (FMS-92): `alerts.depot_id` (scope), `trip_id`, `entity_type`/`entity_id` (the subject's public id), `dedup_key` with `occurrence_count` and `last_occurred_at` (a repeat within the rule's window updates the active alert), `escalation_level`/`escalated_at`, `acknowledged_by`/`resolved_by`, `details`; indexes for de-duplication, a depot's alerts and escalation |
| 034 | `alert` | Incident reports (FMS-38): `incident_reports.depot_id` (scope: the vehicle's depot, or the reporter's), filled in from the vehicle for existing rows; a location is both coordinates or neither; indexes for a depot's incidents and a reporter's own |
| 035 | `tracking` | Telemetry rules (FMS-46): `rule_thresholds` (speed limit, pings to raise and to clear, idling minutes; one fleet row, overridden per depot; the fleet row starts at 80 km/h, 3, 3, 5 min); one ongoing flag per vehicle and type (`ux_telemetry_flags_ongoing`), older duplicates closed first |
| 036 | `maintenance` | Failure records (FMS-125): `failure_events` (vehicle, the repair or incident it came from, component, failure mode, unplanned, how it was detected, when, odometer); the component, mode and detection catalogues as enums; indexes by vehicle and by component, newest first |

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

- **Depot scoping.** `auth.users.depot_id` is the single source of a user's home depot (NULL = depot-unscoped, e.g. admin). A driver's depot is their user's depot; `fleet.drivers` keeps no copy, so the two cannot drift. `GET /drivers?depot_id=` filters through the account: the fleet module asks the auth module (`userDirectory` in its `index.ts`) for the matching user ids, since fleet SQL may not query `auth.users` (FMS-12).
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
