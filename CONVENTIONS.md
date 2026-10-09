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
| Show a status | `<StatusBadge status="...">`, not your own coloured span |
| Show or enter money/fuel | `MoneyDisplay`, `FuelDisplay`, `MoneyInput`, `FuelInput` |

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

Every mutation writes an `audit.audit_logs` row **in the same transaction** (Definition of Done 5). Use `req.dbMutate(table, action, id, data)` in a request, or `Repository.mutate(ctx, ...)` inside a repository; both call `auditedMutation`. `audit.audit_logs` is append-only: the database refuses `UPDATE`, `DELETE` and `TRUNCATE`. Secrets (`password_hash`, `token_hash`) are redacted from the stored values and passwords are never logged. Authentication events (login, logout, refresh reuse) are audited by the auth module; see `docs/auth.md`.

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
| `fleet` | fleet | depots, vehicles, drivers, driver_vehicle_assignments, driver_attendance, dvir_reports |
| `trip` | trip | routes, trips, trip_stops |
| `fuel` | fuel | fuel_logs, fuel_anomalies |
| `maintenance` | maintenance | maintenance_records, maintenance_parts, maintenance_predictions, inventory_parts, inventory_movements |
| `alert` | alert | alerts, alert_acknowledgements, incident_reports, notifications |
| `ev` | ev | charging_stations, charging_sessions, ev_battery_logs |
| `integration` | integration | external_providers, gps_devices, fuel_card_transactions, sync_logs |
| `analytics` | analytics | analytics_cache and read-only views |
| `audit` | audit | audit_logs |
| `tracking` | integration | gps_pings (default partition included), telemetry_flags, vehicle_current_location. `trip` reads positions through the integration module's `index.ts` |
| `document` | fleet | documents |
| `api` | platform (`src/shared`) | idempotency_keys, used by the Idempotency-Key middleware (FMS-87) |
| `shared` | platform | enum types and trigger functions only; no tables |

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

Modules react to each other through events. Status: until FMS-73 (Sprint 3) brings the outbox and Redis pub/sub, `eventBus` in `src/shared/events` delivers in process, after the transaction commits, at most once. Publish with `eventBus.publish([createEvent(type, payload, ctx)])` once the transaction has resolved; FMS-73 keeps the interface. Follow these rules from the start so modules are ready.

- **Name:** `PastTense` PascalCase, a fact that already happened: `TripAssigned`, `FuelAnomalyDetected`. Not `AssignTrip`, `TripAssigning` or `TripUpdate`.
- **Envelope:** every event is `{ id, type, version, occurred_at, actor, correlation_id, payload }`. `id` is unique per event, `version` starts at 1 and increases when the payload changes shape, `correlation_id` is the request's id.
- **Payload carries ids, not personal data.** Consumers re-read what they need through the owning module, with their own authorization.
- **Delivery is at least once**, so a consumer must be idempotent by event `id`.
- **Publish in the same transaction as the change.** A rolled-back change publishes nothing.
- **Catalogue** (extended as events are added): `VehicleRegistered`, `VehicleUpdated`, `VehicleRetired` (fleet, FMS-15), `DriverRegistered`, `DriverRetired` (fleet, FMS-16), `TripAssigned`, `TripStarted`, `TripCompleted`, `VehicleLocationUpdated`, `FuelAnomalyDetected`, `MaintenanceRiskDetected`, `VehicleFaultDetected`, `AlertCreated`, `BatteryThresholdExceeded`.

## API

- Every endpoint is under **`/api/v1/`**. A breaking change gets `/api/v2/`; additive changes stay in v1.
- Success body `{ data, meta: { request_id } }`; errors as above. Field names are `snake_case`, enum values lowercase `snake_case` exactly as stored (`en_route`), timestamps ISO 8601 UTC, dates `YYYY-MM-DD`.
- Cookie-based sessions: tokens are `HttpOnly; Secure; SameSite=Strict` cookies and never appear in a response body or `localStorage` (`docs/auth.md`).
- Endpoints marked `Idempotency-Key` in the contract must honour it.
- The contract is the source of truth. A change to an endpoint changes `docs/api-contract.md` in the same PR.

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
- Sign-in, tokens and sessions: [docs/auth.md](docs/auth.md).
