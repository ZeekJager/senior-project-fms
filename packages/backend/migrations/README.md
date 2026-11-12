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
| 037 | `maintenance` | Part service items (FMS-52): `service_item` enum (engine oil, air and fuel filters, coolant, brake pads and fluid, clutch fluid, tyres, battery, gearbox oil, belts); `inventory_parts.service_item`, what a part renews when a completed repair uses it, so the predictive model knows when each was last changed; index on it |
| 038 | `fleet` | Meter readings (FMS-126): `meter_readings`, each odometer and engine-hour reading with its source (fuel log, repair, device, the nightly engine-hours job, manual) and source record, when it was true, and whether it is suspect (lower than a trusted earlier reading); unique per fuel log, repair and engine-hours day; every vehicle starts with a manual reading of its current odometer |
| 039 | `maintenance`, `auth` | The model registry (FMS-127): `ml_models`, every predictive maintenance model version the ML service has served (inputs, feature spec version and SHA-256, metrics, training data, trained when, artefact checksum, first seen) with its status (`registered`, `active`, `retired`; one active per name); `maintenance_predictions` (model_name, model_version) must name a registered model; permission `ml-model:activate` (admin) |
| 040 | `maintenance` | The nightly scoring (FMS-55): `maintenance_predictions` gets `health_score`, `risk_level`, `factors` (at most 3) and `as_of` (the scoring time), all set on a scored row; one prediction per vehicle, type, scoring time and model (`ux_predictions_scoring`) |
| 041 | `fuel` | Fuel reconciliation (FMS-41): `fuel_anomalies.fuel_log_id` becomes optional; a reconciliation anomaly names its period (`period_start`, `period_end`) with the figures it was judged on (`distance_km`, `expected_ml`, `actual_ml`); one per vehicle and period (`ux_fuel_anomalies_period`) |
| 042 | `trip`, `tracking` | Buffered pings belong to the trip they were recorded in (FMS-124): partial indexes on `trip.trips` by (driver, `actual_start`) and (vehicle, `actual_start`) for the per-ping trip lookup; the current-location trigger skips a ping inserted under `fms.ping_history_only` (a ping of a trip that has ended is history, not the vehicle's position) |

| 043 | `maintenance` | What a technician found when they inspected a flagged vehicle (FMS-128): `prediction_feedback`, one row per prediction (`uq_prediction_feedback_prediction`) with the outcome (`confirmed_issue`, `no_issue_found`, `already_fixed`, `not_inspected`), and for a confirmed issue the component found and the failure record it led to (`chk_prediction_feedback_found`); never deleted |
| 044 | `analytics` | Fleet KPIs (FMS-50): `analytics_cache` keeps one row per vehicle and Addis Ababa day with its raw figures (`distance_m`, `trips_completed`, `trips_timed`, `trips_on_time`, `fuel_ml`, `fuel_cost_cents`, `maintenance_cost_cents`) beside the ratios, so any range is summed from the cache; read-only views `vehicle_directory`, `trip_facts`, `fuel_facts`, `maintenance_cost_facts` and `alert_facts`, so the analytics module reads its own schema only |
| 045 | `trip` | Routes follow the road (FMS-84): `routes.measured_at` and `routes.distance_source` (`road` or `manual`); `geometry` must be a GeoJSON LineString, set exactly when `measured_at` is; existing typed distances become `manual`; a partial index on the active routes still to be measured (`idx_trip_routes_unmeasured`) |
| 047 | `alert`, `auth` | Handling incidents (FMS-89): `incident_reports` gains `assigned_to`, `notes` (`chk_incident_notes`, up to 4,000 characters), `resolved_at` and `resolved_by` (`chk_incident_resolved`: set exactly when resolved or closed) and `idx_incidents_active`; `incident:manage` for admins, fleet managers, dispatchers and depot admins, while `incident:write` becomes reporting only |
| 048 | `trip` | One-off trips (FMS-139): `routes.is_adhoc`, a route made for one unplanned trip, left out of the route lists; active route names unique per depot among planned routes only (`ux_trip_routes_depot_name` recreated with `NOT is_adhoc`) |
| 049 | `maintenance` | Preventive service programs (FMS-129): `service_programs` (fleet-wide or per depot; vehicle type, fuel type, make and model; intervals by km, days and engine hours, each with its lead window below it; a JSON checklist; retired, never deleted; one active name per depot), `maintenance_records.service_program_id` (preventive work only), `service_due` (each vehicle's service under each program: what it counts from, when each measure falls due, the readings and the status `upcoming`, `due`, `overdue`; a read model), and `service-program:write` for admin, fleet manager and depot admin |
| 050 | `fleet`, `analytics` | Vehicle downtime (FMS-131): `fleet.downtime_reason` and `fleet.downtime_periods`, each stretch a vehicle was out of service, known by what opened it (`opened_by`, `uq_downtime_periods_opened`) so a staff member's `reason_override` survives rebuilds, with `reason` generated from it and `derived_reason`, its work order and failure, at most one open per vehicle (`ux_downtime_periods_open`); read-only views `analytics.downtime_facts` and `analytics.vehicle_service_spans` |
| 051 | `fleet`, `auth` | Driver attendance by QR scan (FMS-141): `depots.work_starts_at` (default 08:00) and `late_after_minutes` (default 15, `chk_depot_late_after` 0-240); `driver_attendance.check_in_at`, `check_in_method`, `check_out_at`, `check_out_method` (`qr` or `manual`; `chk_attendance_check_in` and `chk_attendance_check_out`: a time with its method, a check-out only after a check-in); `attendance:check-in` for drivers (and admin) and `attendance:qr` for admins, fleet managers, dispatchers and depot admins |
| 052 | `settings`, `auth` | Settings (FMS-80): the `settings` schema and `settings.settings` (one row per setting changed from its default, `value` NULL back to it; `ux_settings_key`, `chk_settings_key`), `settings:write` for admins (the settings screen and the telemetry rules' thresholds) |
| 053 | `trip` | Live arrival times (FMS-86, docs/eta.md): `trip_stops.eta`; `trip_etas` (one row per trip estimated: `arrival_at`, `remaining_km`, `remaining_seconds`, `position_at`, `computed_at`, and `checked_at_position`, which spaces estimates 30 seconds of position time apart), a table of its own so an estimate never bumps the trip's `version` |
| 054 | `analytics` | Reports and exports (FMS-91, docs/reports.md): read-only views `maintenance_facts` (type, status, created and completed, labour, cost), `trip_history_facts` (trip with route, depot, driver and plan), `driver_directory` (name, home depot), `telemetry_flag_facts` (flags with their trip's driver), `incident_facts` and `depot_directory` (name, code), so the reports read `analytics.*` only |
| 055 | `alert` | Notification channels (FMS-93, docs/notification-channels.md): `alert.push_subscriptions` (a browser's Web Push endpoint, key and auth secret, one owner per endpoint) and on `alert.notifications` `next_attempt_at` (when a queued email, SMS or push is due) and `push_subscription_id`, with a partial index over the queued ones for the delivery job |
| 056 | `backup`, `auth` | Database backups (FMS-144, docs/backups.md): `backup.backups` (each pg_dump the runner took: `kind` scheduled or manual, `status` queued, running, succeeded, failed or expired, who requested it, its storage key, size, SHA-256, error and when the file expires; `chk_backup_succeeded` and `chk_backup_failed`) and `backup.restore_drills` (each restore into an empty database, `npm run backup:restore -- --drill`); `backup:read` and `backup:write` for admin |
| 057 | `auth`, `fleet` | Photos of people and vehicles (docs/photos.md): `photo_key`, `photo_type` (`image/jpeg`, `image/png`, `image/webp`) and `photo_updated_at` on `auth.users` and `fleet.vehicles`, all set or all null (`chk_user_photo`, `chk_vehicle_photo`); the image itself is in the document storage |
| 058 | `fleet`, `fuel` | Per-fill-up fuel anomaly rules (FMS-82): `vehicles.tank_capacity_ml` (the limit one fill-up cannot pass; null while unknown); `fuel_anomalies.details`, the figures a rule judged a fill-up on; one anomaly per fill-up and rule (`ux_fuel_anomalies_fill_up_rule`), so a redelivered `FuelLogged` adds nothing |
| 059 | `system` | System health (FMS-143, docs/system-health.md): `system.health_samples` (per component and minute: ok, down with its error, or disabled, and the latency; down from any instance wins) and `system.request_rollups` (per minute: requests, 5xx answers and a latency histogram, counts only), both kept 30 days; `system:read` for admin |
| 060 | `tracking`, `auth` | Geofences and route deviation (FMS-90, docs/geofences.md): `tracking.geofences` (a depot's polygon, `keep_in` or `keep_out`, applying `always` or `off_trip`; GeoJSON ring with its bounding box and area; unique active name per depot; soft deleted, versioned), `telemetry_flags.geofence_id` (a `geofence_violation`'s fence; `ux_telemetry_flags_ongoing` now on vehicle, type and fence, nulls not distinct), `rule_thresholds.route_deviation_m` (500, 100-5000) and `route_deviation_pings` (3, 1-20); the `geofence:write` permission, admin only. Down closes all but the newest ongoing geofence flag of each vehicle before restoring the two-column index |
| 061 | `integration` | Telematics provider slot and device onboarding (FMS-138, docs/telematics.md): `gps_devices.last_error_reason` and `last_error_at` (why its last refused position was refused); `integration.webhook_daily_counts` (per provider and Addis Ababa day: deliveries stored and refused, positions stored and refused; counters, so forged traffic cannot fill a table); `integration.unknown_devices` (device ids a provider's signed deliveries named that are linked to no vehicle, first and last seen, positions; at most 1,000 per provider); the `fms-simulator` telematics provider, added switched off (the GPS simulator switches it on). Down keeps the provider row if devices or sync logs use it |
| 062 | `trip` | Completing a trip's stops (FMS-95, docs/trip-stops.md): `trip_stops.completed_at` and `completed_by` (when a stop was marked done, and who; null if that user is deleted); stops already `completed` get their arrival, or last change, as the time; `chk_trip_stop_completed` (a completed stop has its time) |
| 063 | `privacy`, `fleet`, `auth` | Personal data encrypted at rest (FMS-104, docs/driver-data-protection.md): the `privacy` schema (`encrypt_text`, `decrypt_text`, `blind_index`, pgcrypto, the key from the session setting `fms.data_key`); triggers encrypt `fleet.drivers.license_number` and `emergency_phone` and `auth.users.phone`; `drivers.license_number_idx`, an HMAC blind index, carries the licence's uniqueness (`ux_drivers_license_number_idx`). Encrypts existing rows, so it needs the key when there are any |
| 064 | (database) | `pg_stat_statements` (FMS-75, docs/metrics.md): the extension, for the slowest and most frequent SQL; collects once the server preloads it (the Compose stack does). A server without it, or a role that may not create it, gets a notice and the migration passes |
| 065 | `maintenance`, `fleet` | Warranties and recalls (FMS-133, docs/warranties-recalls.md): `maintenance.warranties` (whole vehicle or one component, provider, start, end date and/or end odometer, voided not deleted); the warranty claim on `maintenance_records` (`warranty_id`, `claim_status` claimable, submitted, approved or rejected, `claim_amount_cents` on an approved one, `claim_reference`, who and when); `maintenance.recalls` (campaign code unique ignoring case, make, model, model years) and `maintenance.recall_vehicles` (open, scheduled with its work order, completed); `fleet.expiry_notices` takes the subject `warranty` |
| 066 | `trip` | Each trip's actual distance, measured (FMS-145, docs/trip-distance.md): `trips.actual_distance_source` (`odometer` or `gps`; null with a distance entered before, by the seed or an import), `actual_distance_points` (the positions it was measured from) and `actual_distance_measured_at` (set together with the count: measured, a distance found or not); a source needs a distance (`chk_trip_distance_source`); `idx_trip_trips_unmeasured` for the backfill |
| 067 | `analytics` | The driver performance score (FMS-146, docs/analytics.md): read-only view `dvir_facts` (each inspection with its driver, trip and type, for the score's DVIR completion) and `driver_users` (each driver's sign-in, so a driver's own score is found from it; not a column of `driver_directory`, which 054 re-creates with `CREATE OR REPLACE`) |
| 068 | `tracking`, `trip` | The trip delay alert (FMS-147, docs/eta.md): `rule_thresholds.trip_delay_minutes` (15) and `trip_delay_urgent_minutes` (60, above the first; `chk_rule_trip_delay_urgent`); `trip_etas.delay_level` (`late` or `urgent` while a trip is alerted as late, else null) and `delay_episode` (how many times it has fallen late, one alert each) |
| 069 | `analytics` | The fleet-wide health score trend (FMS-150, docs/vehicle-health.md): `analytics.health_score_history`, every health score the nightly batch stored (active or superseded) with its `risk_level` and `as_of`, read by `GET /analytics/health-trend` |
| 070 | `tracking`, `trip`, `auth` | Approved exceptions to the assignment rules (FMS-151, docs/assignment-exceptions.md): `rule_thresholds.attendance_exception` and `overrun_exception` (`warn`, the default, or `approve`; `chk_rule_assignment_exceptions`); `trip.assignment_exceptions`, an assignment held for a fleet manager (the trip, driver and vehicle asked for, the warnings, the dispatcher's reason, `pending`, `approved`, `refused` or `withdrawn`, who decided, when and why; one pending per trip, `uq_assignment_exception_pending`); the permission `assignment-exception:approve` (admin, fleet manager) |
| 071 | `trip` | The load of a job on each trip (FMS-153, docs/job-load.md): `trips.cargo_weight_kg` (optional, positive) and `cargo_kind` (`general`, the default, `fragile`, `hazardous`, `refrigerated` or `passengers`; `chk_trip_cargo`). The job load itself is worked out on read, never stored |
| 072 | `fleet` | Ethiopian driving licence classes (SE-198, docs/driving-licences.md): `drivers.license_categories` holds the domestic classes (`motorcycle`, `automobile`, `taxi_1`, `taxi_2`, `public_1`, `public_2`, `dry_cargo_1`-`3`, `liquid_cargo_1`-`2`, `special`; `chk_driver_license_categories`), each driver's European codes converted; `vehicles.body` (`passenger`, `dry_cargo`, `tanker`, `special`), `seats` and `gross_weight_kg`, optional (`chk_vehicle_licence_details`) |

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

Backups from the admin screen and the nightly job (FMS-144) are described in [docs/backups.md](../../../docs/backups.md). The database architecture expects:

- nightly full backups
- continuous WAL archiving
- encrypted backup storage
- tested restore procedures
- a PostgreSQL read replica for analytics/read-heavy workloads

Exact RPO/RTO values should come from the final SRS.

## Migration runner

The files use the same `-- +migrate Up` / `-- +migrate Down` markers as the previous migration set. Run them in numeric order.
