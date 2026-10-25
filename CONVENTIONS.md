# Conventions

Decisions that have caused, or could cause, a disagreement. It is not a style guide: formatting and lint rules are enforced by ESLint and the TypeScript compiler. If a decision is missing here, make it in your PR and add it.

Read this with the four reference documents: the [API contract](docs/api-contract.md), the [migrations](packages/backend/migrations/README.md) (the database schema), the [MVP scope](docs/fms-mvp-spec.md) and the [screen inventory](docs/screen-inventory.md).

## Quick answers

**Where do I store a fuel amount?** As an integer number of millilitres, in a column named `*_ml` (`fuel.fuel_logs.quantity_ml`), sent in the API as `fuel_ml`. Never a float, never litres. See [Money and fuel](#money-and-fuel).

**How do I call another module?** Import from that module's `index.ts` and nothing else, or publish a domain event. Never import its `api/`, `application/`, `domain/` or `infrastructure/` files and never query its tables. See [Modules](#modules).

| I need to... | Do this |
|---|---|
| Write a row | `req.dbMutate(...)` or a `Repository.mutate(...)`, so the audit row is written in the same transaction |
| Remove a row | Set `is_active = FALSE`. `DELETE` SQL is forbidden on core entities |
| Return an id to the client | `public_id` (UUID), never the numeric `id` |
| Protect a route | Declare its permission code (`resource:action`); there is no unprotected-by-default route |
| Report an error | Throw an `AppError` with a code from api-contract §3.6 |
| Call an outside system or receive its webhook | Write an adapter in the integration module; call only through its client (timeout, retries, breaker). Secrets in `INTEGRATION_<CODE>_*`, never in the database (`docs/integrations.md`) |
| Show a status | `<StatusBadge status="...">`, not your own coloured span |
| Show or enter money/fuel | `MoneyDisplay`, `FuelDisplay`, `MoneyInput`, `FuelInput` |
| Add or change a predictive-maintenance input | Edit `packages/ai-service/feature_spec.json` and the core's feature extractor in the same change. The spec hash changes, so the model is retrained ([docs/ml-dataset.md](docs/ml-dataset.md)) |
| Train a predictive model | `python scripts/train.py --version pm-YYYY.MM` in `packages/ai-service`: it writes nothing unless the model passes its grading. Never commit `models/`; open a model only with `ml.artefact.load`, which checks its checksum and feature spec hash ([docs/ml-model.md](docs/ml-model.md)) |

## Money and fuel

Money is an **integer number of Ethiopian cents** and fuel volume an **integer number of millilitres**, everywhere: database, API, backend code and frontend state. `149.99 ETB` is `14999`; `23.5 L` is `23500`.

- Columns end in `_cents` (`unit_cost_cents`, `total_cost_cents`) or `_ml` (`quantity_ml`). Types are `INT`/`BIGINT`, never `NUMERIC`, `FLOAT` or `DOUBLE`.
- The API sends and accepts integers. A fractional value is rejected with `VALIDATION_FLOAT_IN_MONEY_PATH`.
- Conversion to and from human values happens in exactly two places: `lib/units.ts` (backend) and the frontend components in `components/shared/` (`MoneyDisplay`, `FuelDisplay`, `MoneyInput`, `FuelInput`; see `docs/shared-ui.md`). Do not format or parse a money or fuel value anywhere else.
- The ESLint rule `fms/no-float-in-money-path` blocks `parseFloat`, `Number()` and `/` on variables named `cost*`, `fuel*`, `birr*`, `cents*` or `ml*`. Do not rename a variable to get around it.
- Parse typed amounts from the text, not by multiplying: `1.005 * 100` is `100.49999999999999`, so a multiplying parser stores 100 cents. The shared inputs reject a third decimal instead of rounding it.

## Soft delete

Rows are never deleted. A core entity is retired by setting `is_active = FALSE`; `DELETE` SQL is forbidden on core entities (Definition of Done 6). `auditedMutation(..., 'DELETE', ...)` already performs the soft delete.

- Queries for live data filter on `is_active = TRUE`. A retired row can still be read by id for history, and keeps its foreign keys.
- `auth.users.is_active` is a generated column derived from `status` (`active` is the only active status). Deactivate a user by changing `status`, never by writing `is_active`.
- The one exception is `document.documents`, which has `deleted_at` and `deleted_by` because a document retirement is subject to a retention date. Do not copy that pattern to other tables.
- Lookup and join tables (`auth.user_roles`, `auth.role_permissions`) are not core entities and may be deleted from.

## Audit

Every mutation writes an `audit.audit_logs` row **in the same transaction** (Definition of Done 5). Use `req.dbMutate(table, action, id, data)` in a request, or `Repository.mutate(ctx, ...)` inside a repository; both call `auditedMutation`. `audit.audit_logs` is append-only: the database refuses `UPDATE`, `DELETE` and `TRUNCATE`. Secrets (`password_hash`, `token_hash`) are redacted from the stored values and passwords are never logged. Authentication events (login, logout, refresh reuse) and refused requests (`access.denied`) are audited by the auth module; see `docs/auth.md`.

Every audit row also records (FMS-27, migration 024):

- **`request_source`**: `{channel, ip, user_agent}`. The channel is `web` (the browser app), `pwa` (the installed app, which sends `X-Client-Channel: pwa`), `job` (a scheduled job), `webhook` (a route mounted with `webhookChannel`) or `script` (seed, `user:create`, tests outside a request). Clients can only claim `web` or `pwa`.
- **`result`**: `success`, `denied` (refused by a rule: a permission, the login throttle, token reuse) or `failed` (attempted and did not work: a wrong password, a job error).
- **Jobs act as the system**: `user_id` is null, `request_source` is `{channel: "job", actor: "system", job: <name>}`, and `correlation_id` is the run's UUID (see docs/jobs.md). A mutation a job makes passes `{ userId: null, correlationId: context.correlationId }`.

Nothing to pass: `recordAuditEntry` takes the source from the request or job it runs in (`src/shared/infrastructure/request-source.ts`), and the result defaults to `success`. Pass `result` only for denials and failures. The database refuses a new row without either field.

## Modules

The backend is a modular monolith (ADR-01), TypeScript in `strict` mode (ADR-06). Each module is `src/modules/<module>/`:

```
api/              routes, controllers, request validation
application/      use cases and services (the business logic)
domain/           entities, rules, errors; no Express, no SQL
infrastructure/   repositories (SQL) and adapters to outside systems
index.ts          the module's public interface
```

Dependencies point inward: `api` -> `application` -> `domain`, and `infrastructure` implements what `application` needs. `domain` imports nothing from the other layers.

**Cross-module rules** (System Design §32):

1. **Another module is reached only through its `index.ts`.** `import { authenticate } from '../auth'` is fine; `import ... from '../auth/infrastructure/session.repository'` is not.
2. **Reactions to another module's changes go through domain events**, not direct calls (see [Events](#events)).
3. **No cross-schema SQL.** A module's SQL touches only the schema it owns. `trip` never selects from `maintenance.maintenance_records`; it asks the maintenance module, or reacts to its events.
4. **No module reaches into another's tables for a join "just this once".** If you need the data often, the owning module exposes a query function in its `index.ts`.

Rules 1 and 3 are enforced by ESLint (FMS-12): `fms/no-cross-module-import` and `fms/no-cross-schema-sql` run on every backend `.ts` file in the pre-commit hook (Husky + lint-staged) and in `backend-ci`, so a violating commit is blocked locally and a PR cannot merge.

- `no-cross-module-import`: from `src/modules/<a>/`, another module may only be imported as `'../<b>'` (its `index.ts`), never `'../<b>/domain/...'`; type-only imports included. `src/shared/` imports no module at all.
- `no-cross-schema-sql`: a SQL string or template inside `src/modules/<x>/` may only name `<schema>.<table>` for the schemas module `x` owns (table below), plus `shared` (types and functions). The same applies to the table argument of `dbMutate` / `mutate` / `auditedMutation`. Quoted values and SQL comments are ignored; a dynamic `${table}` cannot be checked.

When the linter stops you:

- **You need another module's data:** call a function exported from its `index.ts` (rule 4). Example: auth shows the user's depot as a public id, which `fleet` provides through `depotDirectory`.
- **The two modules would import each other** (fleet already imports auth for `authorize`): the lower module declares an interface and the composition root `src/modules/index.ts` hands it the implementation. Example: `provideDepotDirectory(depotDirectory)`.
- **Writing the audit trail:** use `auditedMutation` or `recordAuditEntry` from `src/shared/infrastructure`. They are the only code that writes `audit.audit_logs`; no module writes the audit schema's SQL itself.

Code used by several modules lives in `src/shared/` (errors, HTTP helpers, repository base class, transactions, logging). Shared code never imports from a module.

### Schema ownership

One PostgreSQL schema per module. Tables are created only by that module's migrations. The full table-by-table list, with the developer track that owns each schema, is CFG-5 in Jira (SE-107); this table is the same ownership in short.

| Schema | Owning module | Tables |
|---|---|---|
| `auth` | auth | users, roles, permissions, role_permissions, user_roles, refresh_sessions |
| `fleet` | fleet | depots, vehicles, drivers, driver_vehicle_assignments, driver_attendance, dvir_reports, driver_accounts (read model of drivers' account fields, migration 017), meter_readings (odometer and engine-hour history, migration 038) |
| `trip` | trip | routes, trips, trip_stops |
| `fuel` | fuel | fuel_logs, fuel_anomalies |
| `maintenance` | maintenance | maintenance_records, maintenance_parts, maintenance_predictions, inventory_parts, inventory_movements, failure_events |
| `alert` | alert | alerts, alert_acknowledgements, incident_reports, notifications |
| `ev` | ev | charging_stations, charging_sessions, ev_battery_logs |
| `integration` | integration | external_providers, gps_devices, fuel_card_transactions, sync_logs |
| `analytics` | analytics | analytics_cache and read-only views |
| `audit` | audit | audit_logs |
| `tracking` | integration | gps_pings (default partition included), telemetry_flags, vehicle_current_location. `trip` reads positions through the integration module's `index.ts` |
| `document` | fleet | documents |
| `api` | platform (`src/shared`) | idempotency_keys, used by the Idempotency-Key middleware (FMS-87) |
| `shared` | platform | enum types and trigger functions only; no tables |

Two modules own no schema and read through other modules' `index.ts`: `command-center` and `realtime` (the Socket.IO gateway, FMS-43). Every folder under `src/modules` needs its entry in `packages/eslint-plugin-fms/lib/module-boundaries.js`, `[]` for these; the plugin's tests fail otherwise.

Foreign keys to another module's table are allowed in the database (they are integrity, not access). Reading through them is not.

The linter's copy of this table is `MODULE_SCHEMAS` in `packages/eslint-plugin-fms/lib/module-boundaries.js`. Its tests fail when a migration creates a schema with no owner there, or a folder under `src/modules` has no entry, so a new module or schema updates both.

## IDs

The API exposes `public_id` (a UUID) and never the numeric `id`, so identifiers cannot be guessed or counted. Every core table has both. Resolve `public_id` to `id` once, at the API boundary, then use `id` internally. Numeric ids appear in the database, in `audit.audit_logs.entity_id` and in server logs only.

## Permissions

A permission code is `resource:action`: `vehicle:write`, `fuel-anomaly:read`, `alert:ack`. The 51 codes and the role grants are seeded in migration `001_core_identity.sql` and are the exact strings in the "Auth / permission" column of the API contract; add a code in a migration and in the contract together.

- **Deny by default.** A route with no declared permission stops the app from starting. A caller without the permission gets `403 FORBIDDEN_INSUFFICIENT_ROLE`; no session gets `401`, never `403`.
- **Out-of-scope records return `404`, not `403`**, so a depot A user cannot learn that a depot B record exists.
- **Check permissions, not role names.** Roles are bundles of permissions that change; code that tests `role === 'dispatcher'` breaks when a grant moves. The frontend does the same: `RoleGate permission="..."` uses the codes from `/auth/me`.
- **A permission is not a scope.** Drivers hold `fuel:read` (they enter and review their own fuel), so `GET /fuel-logs` is allowed for them, and the repository must limit what they get. Any endpoint a driver can read returns only the driver's own records: filter with `ownDriverScope`, and answer another driver's record by id with `404`, not `403`.
- **Hiding a button is not security.** The server enforces every permission; the frontend gate only decides what to render.

Use `authorize('resource:action')` on every route, or `authenticated()` / `publicRoute()` on purpose; the app will not start with a route that declares none. Filter rows with `depotScope` / `ownDriverScope` and `scopeClause` inside the repository. How, and the role-to-permission table, are in [docs/auth.md](docs/auth.md#authorization) and [docs/permissions.md](docs/permissions.md).

## Errors

- `error.code` is `SCREAMING_SNAKE_CASE`, prefixed by its category: `VALIDATION_`, `AUTH_`, `FORBIDDEN_`, `CONFLICT_`, or standalone (`NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_SERVER_ERROR`, `UPSTREAM_UNAVAILABLE`).
- The catalogue is [API contract §3.6](docs/api-contract.md#36-error-codes). It is the only list. The backend mirrors it in `ERROR_CODES` (`src/shared/errors/app-error.ts`); a new code is added to the contract, to `ERROR_CODES` and to the tests in the same PR.
- Throw `AppError` (or a helper such as `notFound`); the error handler turns it into the envelope `{ error: { code, message, details }, meta: { request_id, timestamp } }`. Do not build error responses by hand.
- Messages never reveal internals (SQL, stack traces, file paths) and never say which half of a credential was wrong.
- The frontend maps errors by `error.code`, not by message text.

## Events

Modules react to each other through domain events (FMS-73; how it works: [docs/events.md](docs/events.md)). A module writes its events into the outbox (`events.outbox`) **in the transaction that makes the change**. After commit, the relay hands them to the in-process consumers and publishes them on Redis for the real-time layer.

```ts
await vehicles.inTransaction(async (client) => {
  // ... the change, audited ...
  await this.deps.events.publish(client, [
    createEvent(VEHICLE_EVENTS.retired, { vehicle_id: view.id }, ctx, { aggregate: aggregateKey('vehicle', view.id) }),
  ]);
});

eventBus.subscribe('MaintenanceRecordOpened', 'fleet.vehicle-cache', async (event, tx) => { /* ... */ });
```

- **Name:** `PastTense` PascalCase, a fact that already happened: `TripAssigned`, `FuelAnomalyDetected`. Not `AssignTrip`, `TripAssigning` or `TripUpdate`.
- **Envelope:** every event is `{ id, type, version, occurred_at, actor, correlation_id, payload }`.
  - `id` is unique per event.
  - `version` starts at 1 and increases when the payload changes shape.
  - `actor` is the user's public id, or null for the system.
  - `correlation_id` is the request's id (a job's run id).
- **Payload carries ids, not personal data.** Consumers re-read what they need through the owning module, with their own authorization. Events are retained for a week and go out on Redis.
- **Publish in the change's transaction, at its end.** Call `events.publish(client, [...])` after the aggregate's row is written (so it is locked), never after commit and never on the pool. A rolled-back change publishes nothing; a committed one cannot lose its event.
- **Aggregate:** pass `aggregate: aggregateKey('<kind>', publicId)` for the entity the event is about. Consumers get one aggregate's events in the order they were written; a consumer failing on one holds back only that aggregate.
- **Delivery is at least once.** Every subscription names its consumer, `<module>.<purpose>` (`fleet.vehicle-cache`), and the bus records each event a consumer has handled (`events.processed_events`). A redelivered event is skipped.
  - Do database work on the `tx` the handler gets: it commits with that record.
  - Work done elsewhere (a cache delete, a call to another service) must be safe to repeat.
  - Keep a consumer's name once it is released: a renamed consumer sees every retained event again.
- **A failing consumer is retried** with backoff (1 s, 2 s, 4 s ... up to 5 minutes). After 10 attempts its event is dead-lettered and `/health/ready` reports `outbox: "degraded"`. See docs/events.md to retry one.
- **A scheduled job** gives a fact a fixed id with `deterministicEventId(...)`: the outbox keeps one row per id, so a rerun or a second server repeats the id, not the fact.
- **Projections:** a read model that must never be behind its source is kept with `eventBus.project(type, '<module>.<purpose>', handler)` instead of `subscribe`: the handler runs inside `publish`, on the publishing transaction, so it commits or rolls back with the change. A failing projection fails the change, so keep it to the module's own tables and quick queries. There is no redelivery: pair it with a rebuild from the source, declared in `AppModule.readModels`, which the daily job and `rebuildReadModels()` (after the seed or a bulk import) run.
- **Tests:** `publishedEvents(...types)` reads what a test published; `deliverEvents()` runs the relay so consumers react (`test/support/events.ts`). Unit tests over fakes use `RecordingEventBus`.

**Catalogue.** Add a row when you add an event; payloads carry public ids.

| Event | Module | Aggregate | Payload | Consumers |
|---|---|---|---|---|
| `VehicleRegistered`, `VehicleUpdated`, `VehicleRetired` | fleet (FMS-15) | vehicle | `vehicle_id`, `depot_id`; `changed_fields` on update | |
| `DriverRegistered`, `DriverUpdated`, `DriverTransferred`, `DriverRetired`, `DriverReinstated` | fleet (FMS-16) | driver | `driver_id`, `user_id`, `depot_id`; `changed_fields` on update; `from_depot_id`, `to_depot_id` on transfer | |
| `DepotCreated`, `DepotUpdated`, `DepotDeactivated`, `DepotReactivated` | fleet (FMS-20) | depot | `depot_id`; `changed_fields` on update | |
| `AttendanceRecorded` | fleet (FMS-21) | attendance | `attendance_id`, `driver_id`, `date`, `status`, `previous_status` | |
| `DocumentUploaded` | fleet (FMS-17) | document | `document_id`, `owner_type`, `owner_id`, `document_type`, `expires_on` | `fleet.document-expiry` |
| `DocumentExpiring`, `LicenceExpiring` | fleet (FMS-26) | document, driver | `level` (amber, red), `days_left`, the expiry date, owner or driver ids | `alert.engine` |
| `VehicleStatusChanged` | fleet (FMS-76) | vehicle | `vehicle_id`, `depot_id`, `previous_status`, `new_status`, `changed_at`, `changed_by`, `reason`, `source` (`manual`, or `maintenance` as work starts and ends), `maintenance_record_id` (also on `DELETE /vehicles`, with `VehicleRetired`) | |
| `MaintenanceRecordOpened`, `MaintenanceRecordUpdated`, `MaintenanceRecordCompleted` | maintenance (FMS-22) | maintenance | `maintenance_record_id`, `vehicle_id`; `changed_fields`, `maintenance_flag_cleared` | `fleet.vehicle-cache` |
| `InventoryPartCreated`, `InventoryPartUpdated`, `InventoryStockAdjusted`, `InventoryReorderNeeded` | maintenance (FMS-23) | part | `part_id`; stock and threshold on adjust and reorder | |
| `FailureRecorded` | maintenance (FMS-125, [maintenance.md](docs/maintenance.md)) | vehicle | `failure_event_id`, `vehicle_id`, `maintenance_record_id`, `incident_id`, `component`, `failure_mode`, `unplanned`, `detected_by`, `occurred_at`, `odometer_km` | |
| `RouteCreated`, `RouteUpdated` | trip (FMS-83) | route | `route_id`, `depot_id`; `name`, `distance_km` on create; `changed_fields`, `is_active` on update (retiring is an update) | |
| `TripCreated`, `TripUpdated`, `TripCancelled` | trip (FMS-30) | trip | `trip_id`; `route_id`, `depot_id` and the schedule on create; `changed_fields` on a reschedule; `previous_status`, `driver_id`, `vehicle_id` on cancel | `fleet.vehicle-cache` (`TripCancelled`) |
| `FuelLogged` | fuel (FMS-39) | vehicle | `fuel_log_id`, `vehicle_id`, `driver_id`, `trip_id`, `fuel_type`, `quantity_ml`, `total_cost_cents`, `odometer_km`, `previous_odometer_km` (the reading before this one in time), `recorded_at` (when the fill-up happened: `fueled_at`, FMS-115), `created_at` (when it was received) | |
| `VehicleFaultDetected` | fleet (FMS-36, DVIR); integration later (telematics) | vehicle | `source` (`dvir`), `dvir_report_id`, `vehicle_id`, `driver_id`, `trip_id`, `inspection_type`, `defect_count`, `defects` (names), `maintenance_flag_set`; optional `severity` | `fleet.vehicle-cache`, `alert.engine` |
| `TripStarted`, `TripCompleted` | trip (FMS-32) | trip | `trip_id`, `driver_id`, `vehicle_id`, `route_id`, `depot_id`, `scheduled_start`, `actual_start`; `actual_end`, `duration_seconds` on complete | `fleet.vehicle-cache` |
| `TripAssigned` | trip (FMS-31) | trip | `trip_id`, `driver_id`, `vehicle_id`, `previous_driver_id`, `previous_vehicle_id`, `route_id`, `depot_id`, the schedule | `fleet.vehicle-cache` |
| `UserCreated`, `UserRoleChanged`, `UserDeactivated`, `UserAccountChanged` | auth (FMS-78) | user | `user_id`; `roles`, `added`, `removed`, `status`, `sessions_revoked` | `fleet.driver-accounts` (`UserAccountChanged`) |
| `VehicleLocationUpdated` | integration (FMS-88, GPS ingestion) | vehicle | `vehicle_id`, `depot_id`, `trip_id`, `lat`, `lng`, `speed` (km/h), `heading`, `recorded_at`. At most one per vehicle per `TRACKING_EVENT_INTERVAL_SECONDS` of its pings, and only when the ping became the current position | real-time gateway (`vehicle.location.updated`), `integration.telemetry-rules` |
| `TelemetryFlagRaised` | integration (FMS-46, the telemetry rules) | vehicle | `flag_id`, `vehicle_id`, `depot_id`, `trip_id`, `driver_id`, `flag_type` (`speeding`, `idling`), `severity`, `observed_at` (when the condition began), `details` (`speed_limit_kmh`, `speed_kmh`, `consecutive_pings`, or `idle_minutes`; `lat`, `lng`, `flagged_at`) | `alert.engine`, `integration.live-map-cache`, real-time gateway (`vehicle.flag.changed`) |
| `TelemetryFlagResolved` | integration (FMS-46): the flag's condition ended | vehicle | as `TelemetryFlagRaised`, plus `resolved_at`; `details` adds `end_reason` (`cleared`, `moving`, `engine_off`, `signal_lost`), `duration_seconds` and, for speeding, `max_speed_kmh` | `integration.live-map-cache`, real-time gateway (`vehicle.flag.changed`) |
| `NotificationUnreadChanged` | alert (FMS-48) | inbox (per user) | `user_id`, `unread_count`, `reason` (`delivered`, `read`, `read_all`), `changed_at` | real-time gateway (`notifications.unread`, to that user's room only) |
| `AlertCreated` | alert (FMS-92) | alert | `alert_id`, `depot_id`, `alert_type`, `severity`, `priority`, `status`, `entity_type`, `entity_id`, `vehicle_id`, `title`, `message`, `created_at` | real-time gateway (`alert.created`) |
| `AlertUpdated` | alert (FMS-92): a repeat of the alert's source | alert | `alert_id`, `depot_id`, `status`, `severity`, `priority`, `occurrence_count`, `last_occurred_at` | real-time gateway (`alert.updated`) |
| `AlertAcknowledged`, `AlertResolved` | alert (FMS-92) | alert | `alert_id`, `depot_id`, `status`, and `acknowledged_at`/`_by` or `resolved_at`/`_by` (user public ids) | real-time gateway (`alert.updated`) |
| `AlertEscalated` | alert (FMS-92): a critical alert left unacknowledged | alert | `alert_id`, `depot_id`, `status`, `severity`, `escalation_level`, `escalated_at` | real-time gateway (`alert.updated`) |
| `IncidentReported` | alert (FMS-38, incident reports) | incident | `incident_id`, `depot_id`, `vehicle_id`, `driver_id`, `trip_id`, `severity`, `incident_type`, `status`, `latitude`, `longitude`, `occurred_at`, `maintenance_flag_set`, `reported_by_driver_id` (the reporter's driver profile when a driver reported it); never the description | real-time gateway (`incident.created`), `alert.engine` (critical only), `fleet.vehicle-cache` |
| `IntegrationWebhookReceived` | integration (FMS-85) | provider | `sync_log_id`, `provider_id`, `provider_code`, `provider_type`, `event_id`, `kind`, `occurred_at`. The data is not in the event: read it with `webhookDeliveries.find(tx, sync_log_id)`. One event per provider event id (a fixed id) | `integration.telematics-pings` (telematics `positions`, FMS-88); fuel card and EV later |

Trip events and fleet's availability: the `fleet.trip-assignments` projection (FMS-76) takes every type in `TRIP_EVENTS` (trip/domain/trip.ts), needs only `trip_id`, and re-reads the trip's state from the trip module. Every change to a trip's status, schedule, vehicle or driver must publish one of them in its transaction: `TripAssigned` is published by assignment (FMS-31), `TripStarted` and `TripCompleted` by the lifecycle commands (FMS-32). A write that skips them is repaired by the daily rebuild, which logs it as drift.

Planned, named here so modules agree on them. The alert engine (FMS-92, docs/alerts.md) already has a rule for each, reading these payload fields (public ids), so an alert follows as soon as the event is published:

- `VehicleFaultDetected` (integration, from telematics; the DVIR one is above).
- `FuelAnomalyDetected` (fuel, FMS-82): `anomaly_id`, `vehicle_id`, `driver_id`, `trip_id`, `fuel_log_id`, `anomaly_type`, `severity`.
- `MaintenanceRiskDetected` (maintenance, FMS-55): `prediction_id`, `vehicle_id`, `risk_level`, `failure_probability`, `component`.
- `BatteryThresholdExceeded` (ev, FMS-96): `vehicle_id`, `trip_id`, `metric`, `value`, `threshold`, `severity`.

**Real-time (FMS-43).** The Socket.IO gateway forwards some events to browsers (docs/realtime.md). Each is mapped field by field in `realtime/domain/contract.ts`, and its `depot_id` decides who receives it. To show a new event live, add it to the gateway's map as well.

## API

- Every endpoint is under **`/api/v1/`**. A breaking change gets `/api/v2/`; additive changes stay in v1.
- Success body `{ data, meta: { request_id } }`; errors as above. Field names are `snake_case`, enum values lowercase `snake_case` exactly as stored (`en_route`), timestamps ISO 8601 UTC, dates `YYYY-MM-DD`.
- Cookie-based sessions: tokens are `HttpOnly; Secure; SameSite=Strict` cookies and never appear in a response body or `localStorage` (`docs/auth.md`).
- Endpoints marked `Idempotency-Key` in the contract must honour it: add `idempotent()` (`src/shared/http/idempotency.ts`) after `authorize(...)`. It stores the first successful response and replays it to retries (api-contract §19). From the web client, pass `idempotencyKey: true` to `api.request` on those calls. A driver-app form that creates a record submits through the offline queue instead (`useOfflineQueue().submit`, `docs/portals.md`), which keeps the key across retries. Keys are kept 24 hours; a route the offline queue sends to takes `idempotent({ ttlHours: OFFLINE_QUEUE_TTL_HOURS })` (7 days, FMS-116). Expired keys are purged daily by `idempotency-key-purge` (`docs/jobs.md`).
- The contract is the source of truth. A change to an endpoint changes `docs/api-contract.md` in the same PR.
- A new or changed endpoint also goes in `docs/openapi.yaml` (OpenAPI 3.1). `test/integration/openapi.test.ts` fails if an operation listed there is not mounted, a `$ref` is broken, or an error code it names is not in `ERROR_CODES`.

## Redis

Redis (FMS-72) holds the cache, the shared login throttle, job leases and the telemetry rules' counters (FMS-46), and carries domain events to the real-time layer (FMS-73). It is **never the system of record**. Every use has a PostgreSQL or in-process fallback: if Redis is down, the API serves from PostgreSQL, throttles logins per process, locks jobs in `jobs.job_runs`, and domain events wait in the outbox (consumers still get them). `/health/ready` then reports `redis: "degraded"` and stays `200`.

- **Keys:** `<prefix>:<namespace>:<module>:<entity>:<id>`, lowercase, `:`-separated. The prefix is `REDIS_KEY_PREFIX` (default `fms`; tests use `fms-test`).
  - `cache`: `fms:cache:fleet:vehicle:<public_id>` (`cache.key('fleet', 'vehicle', id)`).
  - `throttle`: `fms:throttle:login:<sha256>` (`redisKey('throttle', ...)`).
  - `lock`: `fms:lock:job:<job>:<day>` (`redisKey('lock', ...)`).
  - `state`: `fms:state:integration:telemetry:<vehicle public id>` (`redisKey('state', ...)`): the telemetry rules' counters between pings (FMS-46), kept 24 hours. Not a cache: an outage does not drop it, and while Redis is down the rules count in process.
  - `events`: pub/sub channels, not keys: `fms:events:<EventType>` (`eventChannel(type)`), one per event type, carrying the JSON envelope.
  - Public ids in keys, never internal ids. Never an email, name or other personal data: hash it, as the throttle does.
- **Every key has a TTL.** Redis evicts by least-recent use among keys with a TTL (`volatile-lru`) and saves nothing to disk.
- **Caching a read:** `cache.getOrSet(key, ttlSeconds, loader, revive?)` from `src/shared/cache`.
  - Pass `revive` to restore what JSON loses (Dates).
  - Cache what is the same for every caller, and check the caller's scope against the cached value. The vehicle cache stores the depot with the view, so a depot user's read needs no PostgreSQL.
  - Keep the TTL short (seconds to a minute).
- **Invalidating:** after the write has committed, `cache.delete(key)` (or `cache.invalidate('fleet:vehicle:*')`). Deleting inside the transaction lets a concurrent read re-cache the old row before the commit. A change made inside another module's transaction invalidates on that module's event, which the relay delivers after commit (within a fraction of a second): fleet drops a vehicle on the maintenance events. After an outage every instance drops the whole cache namespace, because invalidations sent while Redis was down were lost.
- **Scripts** that import the app close the connection at the end (`closeRedis()`), or the process never exits.

## SQL

No ORM. Raw, **parameterised** SQL only: values go in `$1, $2, ...` placeholders, never concatenated or interpolated into the query string.

- SQL lives in `infrastructure/` repositories, which take a `Queryable` (a pool or a transaction client) so they can join a caller's transaction. Use `withTransaction` for multi-statement work.
- Table and column names cannot be bound as parameters. They come from literals in code, never from request input; `auditedMutation` rejects anything that is not a plain `schema.table` identifier.
- Schema changes are migrations: `migrations/NNN_name.sql` with `-- +migrate Up` and `-- +migrate Down`, reversible, tested down then up before the PR (Definition of Done 3). Never edit a migration that has been merged; add a new one.

## Status colours

One vocabulary, in `StatusBadge` (`components/shared/StatusBadge.tsx`). Do not colour a status any other way.

| Status | Colour |
|---|---|
| `draft`, `scheduled` | grey |
| `assigned` | blue |
| `en_route` | yellow |
| `completed` | green |
| `cancelled` | red |
| `flagged` | orange |

A new status needs a colour in the same PR (the code will not compile without one). The label is always text; colour is never the only signal.

## File names

| Where | Rule | Example |
|---|---|---|
| Backend source | `kebab-case`, with the role as a dotted suffix (System Design §31) | `vehicle.controller.ts`, `create-vehicle.usecase.ts`, `vehicle.repository.ts`, `password-hasher.ts` |
| Backend tests | next to the file, `.test.ts`; integration tests in `test/integration/` | `token.service.test.ts` |
| Migrations | `NNN_snake_case.sql`, numbered in order | `014_refresh_session_family.sql` |
| React components and pages | `PascalCase.tsx`, one component per file | `RoleGate.tsx`, `Login.tsx` |
| Hooks | `useThing.ts` | `useIdleTimeout.ts` |
| Other frontend TS/JS | `camelCase.ts` | `redirect.ts`, `client.ts` |
| CSS | `kebab-case.css` | `index.css` |

The `middleware/` files that predate this (`auditLog.ts`, `requestContext.ts`, `errorHandler.ts`) are `camelCase`; leave them, name new backend files in `kebab-case`. All backend and frontend source is TypeScript; a new `.js` file in `src/` is not allowed (ADR-06).

## Where to look next

- Branches, commits and the Jira board: [README](README.md#-contribution--jira-workflow) and CFG-1 in Jira.
- Tests: [docs/testing.md](docs/testing.md). CI: [docs/ci.md](docs/ci.md).
- The predictive model's inputs, label and training data: [docs/ml-dataset.md](docs/ml-dataset.md). The model, its grading and its folder: [docs/ml-model.md](docs/ml-model.md).
- Sign-in, tokens and sessions: [docs/auth.md](docs/auth.md).
