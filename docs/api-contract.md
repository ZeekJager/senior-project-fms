# Fleet Management System — Combined API Contract (v1)

**REST API + Internal ML API + Real-Time Events + Webhooks**

Status: canonical architecture and implementation contract, combining the previous API contract with the expanded API specification.

API version: `v1` · Base path: `/api/v1` · Machine-readable companion: OpenAPI 3.1, `docs/openapi.yaml` (endpoints are added as their cards are built; it uses 3.1 for nullable fields as `type: [string, 'null']`)

| Item | Decision |
|---|---|
| Architecture | Modular monolith + one specialized service |
| Core API | Node.js + Express |
| Predictive-maintenance API | Python + FastAPI (internal only) |
| Database | PostgreSQL system of record |
| Cache / Pub-Sub | Redis |
| Clients | React responsive web app / PWA |
| Real-time | Socket.IO / WebSocket |
| API format | JSON / UTF-8 |
| Authentication | HttpOnly cookie-based JWT for browser clients; authenticated service credentials for internal APIs |
| Contract source | This specification + OpenAPI 3.0.3 + contract tests |

## 1. Purpose and Scope

This document defines the canonical API contract for the Fleet Management System (FMS). It combines the earlier API contract with the expanded architecture-aligned contract. It covers externally consumed REST endpoints, driver operations, dispatch and assignment rules, document handling, fuel reconciliation, predictive maintenance, tracking, alerts, EV management, analytics, integration webhooks, real-time events, security, validation, and contract governance.

The Node.js/Express application is the authoritative business API. PostgreSQL is the authoritative system of record. Redis provides cache and pub/sub only. The Python/FastAPI service performs predictive-maintenance inference and does not own fleet master data.

## 2. API Architecture and Boundaries

| Consumer / system | Interface | Purpose | Authority |
|---|---|---|---|
| React Web / PWA | HTTPS REST `/api/v1/*` | Fleet operations and management | Core API |
| Command Center UI | REST + Socket.IO | Live vehicles, alerts and incidents | Core API + Redis fan-out |
| Driver PWA | REST + offline retry | Fuel, DVIR, attendance and trip actions | Core API |
| ML service | Authenticated internal HTTPS `/internal/ml/*` | Predictive-maintenance inference | ML inference only |
| GPS / telematics | Signed webhook / adapter | Telemetry ingestion | Integration boundary |
| Notification providers | Provider adapters | Email/SMS/push delivery | External provider |
| Mapping / traffic / weather | Adapter clients | Route enrichment and ETA | External provider |
| EV charging systems | Adapter/webhook | Charging status and sessions | Integration boundary |

## 3. API Conventions

### 3.1 Base URL and content type

```
https://{host}/api/v1
Content-Type: application/json; charset=utf-8
```

### 3.2 Request correlation

Clients may send `X-Request-Id`. The server accepts or generates a UUID request/correlation id and returns it in the response metadata. The same correlation id is propagated to internal ML and integration calls.

A client value is used only if it is a well-formed UUID; anything else is ignored and the server generates one. The id is stored with every audit entry (`audit.audit_logs.correlation_id`, a UUID column), so an unvalidated value would make the audited write fail.

### 3.3 Standard success envelope

```json
{
  "data": { ... },
  "meta": { "request_id": "uuid" }
}
```

### 3.4 Standard error envelope

```json
{
  "error": {
    "code": "SCREAMING_SNAKE_CASE",
    "message": "Human readable description",
    "details": [{ "field": "registration_number", "reason": "already_exists" }]
  },
  "meta": { "request_id": "uuid", "timestamp": "2026-10-05T07:15:00Z" }
}
```

A detail may carry `record_id`: the public id of the record the problem is about, such as the trip a driver is already on (`CONFLICT_DRIVER_OVERLAP`) or the open maintenance record of a flagged vehicle (`CONFLICT_VEHICLE_FLAGGED`). A refused state change (`CONFLICT_INVALID_STATE_TRANSITION` from the trip commands) carries `allowed_transitions`: the states the record can move to from where it is, empty when it is in a final state.

### 3.5 Identifiers, timestamps and dates

| Convention | Rule |
|---|---|
| Business identifiers | UUID strings: the resource's `public_id` column. Internal numeric keys are never exposed |
| Enumerated values | Lowercase snake_case exactly as stored, e.g. `active`, `diesel`, `en_route`, `high` |
| Timestamps | ISO 8601 UTC |
| Dates | `YYYY-MM-DD` |
| Money | Integer minor units, e.g. cents; do not use floating-point money |
| Fuel volume | Integer millilitres (`fuel_ml`) |
| Speed | Integer km/h; fractional provider values are rounded on ingestion |
| Coordinates | Latitude -90..90; longitude -180..180 |
| Numerical measurements | Decimal values where fractional physical measurements are required |

### 3.6 Error codes

`error.code` is always one of these. The "Raised from" column names the database constraint the API translates, where one exists.

| Code | Status | Meaning | Raised from |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | Request body/query failed schema validation | API |
| `VALIDATION_INVALID_ENUM` | 400 | Value outside the allowed set | API / enum or CHECK |
| `VALIDATION_INVALID_DATE_RANGE` | 400 | End before start, or range too wide | API / `chk_*_times` |
| `VALIDATION_FLOAT_IN_MONEY_PATH` | 400 | Fractional value in a money or fuel field | API |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email or password (same response for both) | API |
| `AUTH_TOKEN_EXPIRED` | 401 | Access token expired | API |
| `AUTH_TOKEN_INVALID` | 401 | Token malformed or signature invalid | API |
| `AUTH_TOKEN_REVOKED` | 401 | Refresh session revoked or reused | `auth.refresh_sessions` |
| `AUTH_ACCOUNT_DISABLED` | 403 | User status is not `active` | `auth.users.status` |
| `FORBIDDEN_INSUFFICIENT_ROLE` | 403 | Caller lacks the required permission | RBAC |
| `NOT_FOUND` | 404 | Resource does not exist or is not visible to the caller | API |
| `PAYLOAD_TOO_LARGE` | 413 | Request body over the size limit (JSON: 1 MB; uploads: §8) | API |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | An upload whose content is not an accepted type (§8: JPEG, PNG, PDF, judged by the file's bytes, not its name or declared type) | API |
| `CONFLICT_DUPLICATE` | 409 | A unique value already exists (constraints without a more specific code); `details` names the field | unique constraint |
| `CONFLICT_DUPLICATE_PLATE` | 409 | Registration number already exists | `uq_fleet_vehicle_registration` |
| `CONFLICT_DUPLICATE_LICENSE` | 409 | Licence number already exists | `drivers_license_number_key` |
| `CONFLICT_VEHICLE_IN_USE` | 409 | Vehicle has an active trip or assignment | API |
| `CONFLICT_DRIVER_IN_USE` | 409 | Driver has an active trip or assignment | API |
| `CONFLICT_DEPOT_NOT_EMPTY` | 409 | Depot still has active vehicles, drivers or users | API |
| `CONFLICT_DRIVER_OVERLAP` | 409 | Driver already assigned in that time window | `ex_trip_driver_overlap` |
| `CONFLICT_VEHICLE_OVERLAP` | 409 | Vehicle already assigned in that time window | `ex_trip_vehicle_overlap` |
| `CONFLICT_VEHICLE_FLAGGED` | 409 | Vehicle has `maintenance_flag` set | API |
| `CONFLICT_DRIVER_NOT_ELIGIBLE` | 409 | Driver cannot drive this trip: retired, account not active, licence expired or wrong class (`details[].reason`) | API |
| `CONFLICT_DEPOT_MISMATCH` | 409 | The vehicle or driver belongs to another depot than the trip (`details[].field`, `reason: "other_depot"`) | API |
| `CONFLICT_ATTENDANCE_DUPLICATE` | 409 | Attendance already recorded for driver/date | `driver_attendance_driver_id_attendance_date_key` |
| `CONFLICT_INVALID_STATE_TRANSITION` | 409 | Status change not allowed from current state | API / `chk_trip_*` |
| `CONFLICT_INSUFFICIENT_STOCK` | 409 | Movement would make stock negative | `inventory_parts_stock_quantity_check` |
| `CONFLICT_ODOMETER_REGRESSION` | 409 | Odometer lower than last reading | API |
| `CONFLICT_CONCURRENT_MODIFICATION` | 409 | Stale `version` (optimistic lock) | `trip.trips.version` |
| `CONFLICT_IDEMPOTENCY_KEY_REUSED` | 409 | Same `Idempotency-Key` with a different body | `api.idempotency_keys` |
| `CONFLICT_IDEMPOTENCY_IN_PROGRESS` | 409 | Same key still being processed | `api.idempotency_keys` |
| `RATE_LIMITED` | 429 | Rate limit exceeded | API |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected error (catch-all; no internals in the message) | API |
| `UPSTREAM_UNAVAILABLE` | 502/503/504 | External provider or ML service failed | API |

### 3.7 Health checks

Unversioned and unauthenticated, for load balancers and container orchestration:

| Endpoint | Returns |
|---|---|
| `GET /health/live` | `200` while the process is running; checks no dependencies |
| `GET /health/ready` | `200` when every required check passes, otherwise `503` with `{status: "unavailable", checks: {database: "failed", ...}}`. Redis is optional (FMS-72): `checks.redis` is `ok`, `degraded` (down: the API serves from PostgreSQL, `status: "degraded"`, still `200`) or `disabled` (not configured). The read replica (FMS-94) is reported the same way as `checks.replica`: `degraded` when it is down or more than `READ_REPLICA_MAX_LAG_SECONDS` behind and reporting reads use the primary; its lag is `metrics.replica` (`lag_seconds`, `in_use`, `max_lag_seconds`, `fallbacks`) |

## 4. HTTP Status Contract

| Status | Meaning | Typical use |
|---|---|---|
| 200 | OK | Successful read/update/action |
| 201 | Created | Resource created |
| 202 | Accepted | Async webhook or job accepted |
| 204 | No Content | Successful logout/retirement where no body is returned |
| 400 | Bad Request | Malformed or semantically invalid request |
| 401 | Unauthorized | Missing/invalid authentication |
| 403 | Forbidden | Authenticated but insufficient permission |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Uniqueness, overlap, state or idempotency conflict |
| 422 | Unprocessable Entity | Structurally valid but domain validation failed |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |
| 502/503/504 | Upstream/availability failure | External provider or dependency failure |

## 5. Authentication and Authorization

The browser-facing API uses JWTs stored in Secure, HttpOnly cookies. The access token is short-lived and the refresh token is rotated. Tokens are not returned to browser JavaScript in ordinary response bodies. Internal service-to-service calls use authenticated service credentials over HTTPS. Authorization is enforced in the API/service layer through permission-based RBAC, not only in React.

### 5.1 Authentication and identity endpoints

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /auth/login` | Authenticate user | Public (throttled: 5 failures per account + IP per 15 min) | `{email,password}` -> session cookies + current user |
| `POST /auth/refresh` | Rotate/renew session | Refresh cookie | Sets new access/refresh cookies + current user; a reused refresh token revokes its session family |
| `POST /auth/logout` | Terminate session | Refresh cookie (works after the access token expired) | `204`, clears session cookies |
| `GET /auth/me` | Current user and permissions | Authenticated | `{user, roles, permissions}` |
| `GET /users` | User administration | `users:read` | Paged `User[]`; `search`, `role`, `status`, `depot_id` |
| `POST /users` | Create user | `users:write` | `UserCreate` -> `201 User`, `meta.password_setup` |
| `GET /users/{user_id}` | Get user | `users:read` | `User` |
| `PATCH /users/{user_id}` | Update user | `users:write` | `UserUpdate` -> `User` |
| `POST /users/{user_id}/password-reset` | Issue a password link | `users:write` | `201 {token,purpose,expires_at}` |
| `GET /roles` | List roles/permissions | `roles:read` | `Role[]` |
| `POST /auth/password` | Set a password with a one-time link | Public (the link is the credential) | `{token,password}` -> `204` |

Cookies, token lifetimes, rotation and the audit events are described in [auth.md](auth.md).

User administration rules (FMS-78):

- **Who:** `users:read` and `roles:read` are held by admin, fleet_manager and compliance_officer; `users:write` by **admin** only, so a fleet manager gets `403` on every write.
- **`User`:** `id`, `email`, `full_name`, `phone`, `depot_id`, `status`, `roles`, `has_password`, `last_login_at`, `created_at`, `updated_at`. Never a password hash. **`Role`:** `name`, `description`, `permissions`.
- **Fields:** `email` stored trimmed and lower case, unique (`409 CONFLICT_DUPLICATE`, `field: "email"`). `full_name` 1-255 characters. `roles` 1-10 active role names, each once (`400`, `field: "roles.N"`, `reason: "references_missing_record"` for an unknown one). Depot-scoped roles (dispatcher, driver, technician, depot_admin, finance_clerk) need a `depot_id` (`400`, `reason: "required"`). `status` (PATCH only): `active`, `inactive`, `suspended`, `locked`. Anything else is `not_writable`; there is no password field.
- **No escalation:** a role can be granted or removed only by someone who holds every permission it carries, and `admin` only by an admin (`403 FORBIDDEN_INSUFFICIENT_ROLE`, `reason: "escalation"`). Editing, deactivating or resetting the password of an account follows the same rule for the roles it already holds: resetting an admin's password is taking the admin over.
- **Own account:** nobody changes their own roles (`403`, `reason: "own_roles"`) or deactivates themselves (`409 CONFLICT_INVALID_STATE_TRANSITION`). The last active admin cannot lose the role or be deactivated (`409`, `reason: "last_admin"`).
- **Deactivation:** a `status` other than `active` revokes every refresh session in the same transaction. The user's next request is `403 AUTH_ACCOUNT_DISABLED` and no refresh succeeds.
- **Passwords:** `POST /users` creates the account without a password and returns a one-time setup link in `meta.password_setup` (`{token, purpose: "setup", expires_at}`, 72 hours), shown once (`Cache-Control: no-store`). `POST /users/{id}/password-reset` issues a new link (`reset`, 1 hour; `setup` if the account has no password yet) and closes older ones. `POST /auth/password` sets the password: 12-128 characters, not containing the email (`400`, `field: "password"`, `reason: "too_short" | "too_long" | "contains_email" | "repeated_character"`). An unknown, used or expired link is `400`, `field: "token"`, `reason: "invalid_or_expired"`. Setting a password ends every session of the user. Only the SHA-256 of a token is stored.
- **Audit and events:** account writes are audited (`INSERT`/`UPDATE auth.users`, `INSERT auth.password_tokens`); every role change writes `ROLE_CHANGE` on `auth.user_roles` with `old_values.roles` and `new_values.roles`; a password set writes `auth.password_set`. Events: `UserCreated` (`user_id`, `roles`), `UserRoleChanged` (`user_id`, `added`, `removed`), `UserDeactivated` (`user_id`, `status`, `sessions_revoked`), and `UserAccountChanged` when the profile, depot or status changed.

Permission codes are the `resource:action` values in the "Auth / permission" columns of this document, seeded verbatim in `auth.permissions` (see `001_core_identity.sql` for the role grants).

### 5.2 Audit log

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /audit-logs` | Search the audit trail (screen S-10) | `audit:read` | `user_id,entity_type,entity_id,correlation_id,action,result,from,to` + cursor paging -> `AuditLog[]` |
| `GET /audit` | Legacy-compatible alias | `audit:read` | Same as `GET /audit-logs` |

The audit trail is read-only through the API. There is no create, update or delete endpoint; entries are written by the API in the same transaction as each mutation.

Audit reader rules (FMS-28):

- **Who:** `audit:read`, which admin, fleet owner and compliance officer hold. Migration 025 took it from fleet manager, who now gets `403`, as does a dispatcher.
- **Read from the replica** when it is up (FMS-94): a row written a moment ago may appear a few seconds later. `meta.data_freshness` (FMS-94, [read-replica.md](read-replica.md)): `source` (`replica` or `primary`), `lag_seconds` (how far the data may be behind the primary; 0 from the primary) and `as_of` (now less the lag).
- **Order and paging:** newest first, on (`created_at`, row) so rows written in one transaction keep a stable order. `page_size` 1-200 (default 50). `meta.next_cursor` is the `cursor` for the next page, or `null` on the last. A row written while paging is newer than the cursor, so pages never shift, skip or repeat. A cursor that is not one the API issued is `400`, `reason: "invalid_cursor"`.
- **Filters:**
  - `user_id`: the actor's public id.
  - `entity_type`: a schema-qualified table, e.g. `fleet.vehicles`.
  - `entity_id`: the entity's public id. It matches mutation rows of that entity and, for a user account, its sign-in events and role changes.
  - `correlation_id`: one request or job run.
  - `action`, e.g. `UPDATE` or `auth.login_failed`. Up to 10, comma-separated, each an exact action or a prefix ending in `.*`: `INSERT,UPDATE,DELETE,ROLE_CHANGE` is every data change, `auth.*` every sign-in event (FMS-29). Anything else is `400`, `reason: "invalid_action"`.
  - `result`: `success`, `denied` or `failed`.
  - `from` and `to`: an ISO instant, or a date meaning that Addis Ababa day. A `to` date includes its day; `from` must come before `to`.
  - An unknown `user_id` returns no rows, not `404`.
- **`AuditLog`:**
  - `id`: opaque, unique per row.
  - `occurred_at`: UTC, to the microsecond.
  - `action` and `result`. `result` is `null` on rows written before FMS-27.
  - `actor`: `{type: "user", id, full_name, email}`, `{type: "system"}` (a scheduled job) or `{type: "anonymous"}` (e.g. a failed login).
  - `entity_type` and `entity_id` (public id, when the row carries one).
  - `correlation_id` and `request_source` (channel, IP, user agent).
  - `old_values` and `new_values`: internal numeric ids are removed, public ids kept, and money stays in integer minor units (the UI formats ETB).
  - `details`.
- Responses are `Cache-Control: no-store`.

## 6. Fleet Management API

### 6.1 Depots

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /depots` | List depots | Authenticated | Paged `Depot[]`; `status`, `in_scope`, `search` |
| `POST /depots` | Create depot | `depot:write` | `{name,location,...}` -> `201 Depot`; `Idempotency-Key` |
| `GET /depots/{depot_id}` | Get depot | Authenticated | `Depot` |
| `PATCH /depots/{depot_id}` | Update depot | `depot:write` | `DepotUpdate` -> `Depot`; `If-Match` |
| `PUT /depots/{depot_id}` | Replace depot | `depot:write` | `DepotCreate` -> `Depot`; `If-Match` |
| `DELETE /depots/{depot_id}` | Delete depot (soft) | `depot:write` | `204`; `409 CONFLICT_DEPOT_NOT_EMPTY` |
| `POST /depots/{depot_id}/reactivate` | Restore a deleted depot | `depot:write` | `Depot` |

Depot rules (FMS-20):

- **Who:** every signed-in user reads depots (lists filter by them). Only `depot:write` writes, which **admin and fleet_owner** hold (migration 019 moved it from fleet_manager, who now gets `403`).
- **`Depot`:** `id`, `name`, `code`, `location`, `address`, `city`, `country`, `timezone`, `latitude`, `longitude`, `capacity`, `is_active`, `version`, `created_at`, `updated_at`.
- **Fields:** `name` and `location` required (1-255 characters). `code` optional, letters, digits and hyphens, stored trimmed and upper case, unique (`409 CONFLICT_DUPLICATE`, `field: "code"`). `timezone` an IANA zone (`Africa/Addis_Ababa`). `latitude` and `longitude` both or neither (`400`, `reason: "coordinates_pair"`). `capacity` a whole number of vehicles. `is_active` and anything else is `not_writable`.
- **List:** live depots by name, every depot by default; `in_scope=true` narrows to the caller's depot scope (a depot admin's own), which the screens' depot pickers use. `status=inactive|all` lists deleted depots too and needs `depot:write` (`403` otherwise). `search` matches name, code, location or city.
- **Read:** a deleted depot is `404` except to `depot:write`.
- **PATCH and PUT:** `PATCH` changes the fields sent; `PUT` replaces the depot, clearing optional fields it leaves out. Both take `If-Match` (`409 CONFLICT_CONCURRENT_MODIFICATION` when stale). A deleted depot cannot be changed (`409 CONFLICT_INVALID_STATE_TRANSITION`); reactivate it first.
- **Delete:** soft (`is_active = false`, one audit row, `204`; deleting a deleted depot is `204` and changes nothing). Refused with `409 CONFLICT_DEPOT_NOT_EMPTY` while the depot has active vehicles, drivers or user accounts; `details` names which (`field: "vehicles" | "drivers" | "users"`, `reason: "still_active"`) and the message gives the counts. A deleted depot's vehicles and drivers stay in the database but leave `GET /vehicles` and `GET /drivers`, whatever the status filter, and nothing new can be put in it. A vehicle or driver write and a delete share-lock the depot row, so they cannot race.
- **Events:** `DepotCreated`, `DepotUpdated` (with `changed_fields`), `DepotDeactivated` and `DepotReactivated`, each with `depot_id`.

### 6.2 Vehicles

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /vehicles` | List/search vehicles | `vehicle:read` | `page,page_size,status,depot_id,maintenance_flag,ready_to_dispatch,documents,health,search,sort_by,sort_order,then_by,then_order` -> `Vehicle[]` |
| `POST /vehicles` | Create vehicle | `vehicle:write` | `VehicleCreate` -> `Vehicle` |
| `GET /vehicles/{vehicle_id}` | Get vehicle | `vehicle:read` | `Vehicle` |
| `PATCH /vehicles/{vehicle_id}` | Update vehicle | `vehicle:write` | `VehicleUpdate` -> `Vehicle` |
| `DELETE /vehicles/{vehicle_id}` | Retire/remove vehicle | `vehicle:delete` | `204`. Soft retire; `409 CONFLICT_VEHICLE_IN_USE` if in use |
| `GET /vehicles/{vehicle_id}/status` | Operational status | `vehicle:read` | `from,to` -> `VehicleStatus` |
| `GET /vehicles/{vehicle_id}/meter-readings` | Odometer and engine-hour history (FMS-126) | `vehicle:read` | `meter,from,to,page,page_size` -> paged `MeterReading[]`, newest first |
| `GET /dispatch/availability` | Dispatcher board: a depot's drivers and vehicles, state and availability | `trip:assign` | `depot_id, from, to, exclude_trip_id` -> `DispatchBoard` |
| `POST /vehicles/{vehicle_id}/status` | Change status | `vehicle:write` | `{status, reason}` -> `VehicleStatus`; `If-Match`; `meta.warnings` |

`VehicleCreate` requires `fuel_efficiency_ml_per_km` (integer ml/km) unless `fuel_type` is `electric`; it is the expected consumption used by fuel reconciliation.

Vehicle status and availability (FMS-76):

- **Statuses** (as stored): `active`; `maintenance` (in the workshop); `inactive` (out of service); `retired` (final). `active`, `maintenance` and `inactive` move freely between each other and to `retired`; nothing leaves `retired` (`409 CONFLICT_INVALID_STATE_TRANSITION`, `reason: "<from>_to_<to>"`). (The legacy `decommissioned` is gone from `shared.vehicle_status`.) The maintenance flag is separate: the maintenance module sets it when work is opened and clears it when the last open work closes (FMS-22).
- **Workshop:** work in progress moves the vehicle to `maintenance` (from `active` only, and not while on a trip under way); when the last work in progress on it ends (completed, cancelled or set back to open), it returns to `active`, but only if the maintenance workflow put it there. A status set by hand stays until someone changes it. These changes are recorded with `source: "maintenance"` and the record's id; changes made by a person have `source: "manual"`.
- **Change:** `POST /vehicles/{id}/status` with `{ "status", "reason" }` (reason 3-500 characters; `vehicle:write`, depot scope; optional `If-Match`). A vehicle on a trip under way cannot be put in maintenance, out of service or retired (`409 CONFLICT_VEHICLE_IN_USE`, `record_id` = the trip); trips already assigned ahead do not block, and each comes back in `meta.warnings` as `{ warning: "ASSIGNED_TRIP_AFFECTED", trip_id, start }`. Retiring here has the same rule as `DELETE` (in use: `409`). The same status again changes nothing. Every change (`DELETE` included) is audited, kept in `fleet.vehicle_status_history` with its reason, and published as `VehicleStatusChanged`.
- **`VehicleStatus`:** `vehicle_id`, `registration_number`, `depot_id`, `status`, `maintenance` (`flagged`, `in_workshop`, `open_record_id`), `availability` (`availability`, `reasons[]`, `window`), `current_assignment` (the trip under way, or the assigned one covering now) and `next_assignment` (`trip_id`, `status`, `start`, `end`), `last_status_change` (`from_status`, `to_status`, `reason`, `source` (`manual` or `maintenance`), `maintenance_record_id`, `changed_at`, `changed_by`), `version` (ETag), `updated_at`. `GET` takes an optional window: `from` and `to` (instants, or dates meaning Addis Ababa days); none means now. A window ends at or after it starts and covers at most 31 days (`400 VALIDATION_INVALID_DATE_RANGE`). `vehicle:read` with the depot scope of `GET /vehicles/{id}` (`404` outside it).
- **Availability** is `available`, `unavailable` or `available_with_warning`, with every reason (`code`, `severity` `block` or `warning`, `trip_id` for a trip). A vehicle is unavailable when retired (`vehicle_retired`), in the workshop (`vehicle_in_maintenance`), out of service (`vehicle_out_of_service`), flagged (`maintenance_flag`) or on an assigned or en-route trip that overlaps the window (`assigned_to_overlapping_trip`). A driver is unavailable when retired, their account is not active, their licence has expired on the window's first day, or they are on an overlapping trip; marked `absent`, `on_leave` or `sick` that day is `available_with_warning` (`driver_absent`, `driver_on_leave`, `driver_sick`). Both ends of a window count: a trip ending at 08:00 overlaps a window starting at 08:00.
- **Depot:** a trip is staffed from its own depot. Asked for a depot's trip, another depot's vehicle is unavailable (`vehicle_other_depot`), and so is a driver whose account belongs to another depot or none (`driver_other_depot`). To lend a vehicle, move it to the other depot first (`PATCH /vehicles/{id}` with `depot_id`). The status endpoint asks about the vehicle itself, without a depot.
- **One source:** the fleet module's `fleetAvailability.check(db, { vehicleIds, driverIds, window, excludeTripId, depotId })` answers for the status endpoint, the dispatcher console (FMS-33) and trip assignment (FMS-31) alike. Trip overlaps come from fleet's read model (`fleet.trip_assignments`), kept by the `fleet.trip-assignments` projection inside each trip change's own transaction, so it is never behind the trips; it is also rebuilt daily (`trip-assignment-sync`, which logs any drift) and by `rebuildReadModels()` after the seed or an import.

Dispatcher board (FMS-33, screen S-07):

- **`GET /dispatch/availability`** (`trip:assign`: admin, fleet manager, dispatcher). `depot_id` defaults to the caller's own depot; someone who sees several (or none of their own) must give one (`400 VALIDATION_FAILED`, `reason: "required"`), and one outside their scope is `400 references_missing_record`. `from`/`to` are the trip's window, as for vehicle status (none means now); `exclude_trip_id` is the trip being staffed, whose own assignment is not a conflict.
- **`DispatchBoard`:** `depot_id`, `window`, `drivers[]` and `vehicles[]`. A driver: `driver_id`, `full_name`, `license_categories`, `vehicle_types` (what the licence covers), `state`, `attendance` (on the window's first day), `availability` (`availability`, `reasons[]`, for the window, as in vehicle status), `current_trip` (`trip_id`, `end`) when under way. A vehicle: `vehicle_id`, `registration_number`, `make`, `model`, `vehicle_type`, `status`, `state`, `availability`, `open_work` (the open maintenance record behind a flag: `id`, `description`, `status`, `priority`, `opened_at`; dispatchers hold no `maintenance:read`), `current_trip`. Active drivers of the depot (their account's depot) and its vehicles that are not retired, by name and plate.
- **`state`** is about now, for the console's colours. Drivers: `idle` (green: free, present or not yet marked), `near_end` (amber: under way, ending within 30 minutes or late), `en_route` (red), `absent` (grey: absent, on leave or sick that day; a warning, still assignable), `unavailable` (blocked for the window). Vehicles: `idle` (green), `flagged` (red: maintenance flag or in the workshop), `en_route` (grey), `unavailable`.

Vehicle rules (FMS-15):

- **Writable fields** (`VehicleCreate`; `VehicleUpdate` is any non-empty subset): `registration_number`, `vin`, `make`, `model`, `year`, `vehicle_type`, `fuel_type`, `fuel_efficiency_ml_per_km`, `depot_id`, `odometer_km`. Required on create: `registration_number`, `make`, `model`, `vehicle_type`, `fuel_type`, `depot_id`, and `fuel_efficiency_ml_per_km` unless electric. `status`, `maintenance_flag` and `health_score` are set by their own workflows (vehicle status FMS-76, maintenance, the ML service); sending them, or any other field, is `400 VALIDATION_FAILED` with `reason: "not_writable"`.
- **Values:** `registration_number` is stored trimmed, upper case, single-spaced, so `aa  3-12345` and `AA 3-12345` are the same plate (`409 CONFLICT_DUPLICATE_PLATE`). `vin` is 17 characters (ISO 3779), unique (`409 CONFLICT_DUPLICATE`, `field: "vin"`). A fractional `fuel_efficiency_ml_per_km` is `400 VALIDATION_FLOAT_IN_MONEY_PATH`. `odometer_km` has at most one decimal and never goes down: a lower reading is `409 CONFLICT_ODOMETER_REGRESSION`. It also moves up with trusted meter readings (below). The fuel-efficiency rule is checked on the vehicle as it would be after a `PATCH`.
- **Depot scope:** reads and writes cover the caller's depots only (`depotScope`). A vehicle outside it is `404`; a `depot_id` outside it, on create or `PATCH`, is `400 VALIDATION_FAILED` with `reason: "references_missing_record"`, the same as an unknown depot.
- **Retirement:** `DELETE` sets `status = retired` and `is_active = false` (one audit row) and returns `204`. It is refused with `409 CONFLICT_VEHICLE_IN_USE` while the vehicle is on an `assigned` or `en_route` trip or has an active driver assignment. Retiring a retired vehicle returns `204` and changes nothing. A retired vehicle is left out of `GET /vehicles` unless `status=retired` is asked for, can still be read by id, and cannot be changed (`409 CONFLICT_INVALID_STATE_TRANSITION`). Its plate stays taken.
- **List:** `page` from 1, `page_size` default 25, capped at 100. `search` matches registration number, VIN, make or model (case-insensitive, wildcards literal). `sort_by`: `registration_number` (default), `make`, `model`, `year`, `odometer_km`, `health_score`, `created_at`, `updated_at`, `status`, `vehicle_type`, `depot` (the depot's name); `sort_order` `asc` (default) or `desc`. `then_by` (the same columns) and `then_order` add a second sort for the rows the first leaves tied; the same column twice is just the first sort.
- **Dispatch and document filters** (FMS-18): `ready_to_dispatch=true` lists the vehicles that can be sent out now: `status` is `active`, `maintenance_flag` is false, no `assigned` or `en_route` trip, and no live document past its `expires_on`. `ready_to_dispatch=false` lists the rest. `documents=expired` lists vehicles with a live document past its date; `documents=expiring` those with one expiring within 30 days (today included, the same window as the expiry warnings); `documents=due` either. A deleted document never counts. Dates are calendar dates in Addis Ababa. The filters combine with every other filter, and `meta.total_items` counts the filtered set, so a client can show each view's count with `page_size=1`.
- **Health filter** (FMS-56): `health` is the health score's band, as the screens colour it: `at_risk` (below 75), `watch` (75 to 84), `healthy` (85 and up), each for a score set in the last 25 hours; `stale` (scored more than 25 hours ago, whatever the score); `unscored`. The five are disjoint. Any other value is `400`. Every vehicle reader sees `health_score` and `health_score_updated_at` (when the nightly scoring last set it, null when never); the breakdown behind it is `GET /vehicles/{vehicle_id}/maintenance-risk` (§10.2, `prediction:read`).
- **Current trip:** every `Vehicle` carries `current_trip`: the trip it is on now (`assigned` or `en_route`; en route first, then the earliest scheduled), as `{ id, status, origin, destination, scheduled_start }`, or `null`. Read only; it comes from the trip module (FMS-18).
- **Events:** `VehicleRegistered`, `VehicleUpdated` (with `changed_fields`) and `VehicleRetired`, each with `vehicle_id` and `depot_id` (public ids).
- **Concurrency:** `version` and `ETag` / `If-Match` as described under the driver rules (§6.3).

Meter readings (FMS-126, [meter-readings.md](meter-readings.md)):

- **Sources:** each fuel log (`fuel_log`, at the fill-up) and each completed repair with an odometer (`maintenance`, at its completion) is an odometer reading, added when its event is delivered; a vehicle's own device or telematics provider (`telematics`) at most once an hour per vehicle; a person registering a vehicle or changing its `odometer_km` (`manual`); the nightly engine-hours job (`gps_derived`, engine hours only). Odometers sent by phones or signed-in users are not readings.
- **Suspect:** an odometer reading lower than the highest trusted reading recorded at or before it is stored with `suspect: true`, not refused, and the vehicle's odometer does not follow it. A trusted reading above the vehicle's `odometer_km` moves it up (one audit row; `version` changes).
- **Engine hours:** each local day, for vehicles whose device or telematics pings say whether the ignition is on, the time from one such ping to the next counts when the first had it on and the gap is at most 10 minutes. The day's reading, at the end of the day, is the vehicle's last engine hours plus that time. Phone-only vehicles get none.
- **`GET /vehicles/{vehicle_id}/meter-readings`:** `vehicle:read`, the depot scope of `GET /vehicles/{id}` (`404` outside it, or for an id that is not a UUID). `meter` (`odometer` or `engine_hours`), `from` and `to` (instants, or dates meaning Addis Ababa days; `to` inclusive) filter on `recorded_at`; paged, newest first.
- **`MeterReading`:** `id`, `meter`, `value` (km, or hours), `source`, `source_ref` (the fuel log's or repair's id, the device's id, or the day `YYYY-MM-DD` of an engine-hours reading; `null` for manual), `recorded_at` (when it was true), `suspect`, `created_at`.

### 6.3 Drivers, assignments and attendance

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /drivers` | List/search drivers | `driver:read` | `depot_id,license_expiring_before,license_status,search,status` -> `Driver[]` |
| `POST /drivers` | Create driver | `driver:write` | `user_id` or `account`, `license_number,license_expiry,depot_id` -> `Driver`; `Idempotency-Key` |
| `POST /drivers/import` | Bulk onboarding from CSV | `driver:write` | `text/csv`; all rows or none; `?dry_run=true`; `Idempotency-Key` |
| `GET /drivers/me` | The caller's own driver profile (driver PWA) | Authenticated | `Driver`; `404` if the caller is not a driver |
| `GET /drivers/{driver_id}` | Get driver | `driver:read` | `Driver` |
| `PATCH /drivers/{driver_id}` | Update driver | `driver:write` | `DriverUpdate` -> `Driver` |
| `DELETE /drivers/{driver_id}` | Retire driver | `driver:delete` | `204`. Soft retire; preserve historical references; `409 CONFLICT_DRIVER_IN_USE` if in use |
| `POST /drivers/{driver_id}/reinstate` | Reinstate a retired driver | `driver:write` | `Driver`; history kept; reinstating an active driver changes nothing |
| `POST /driver-vehicle-assignments` | Create driver/vehicle assignment | `assignment:write` | `driver_id,vehicle_id,start_at,end_at` -> `Assignment` |
| `GET /vehicles/{vehicle_id}/assignments` | Assignment history | `assignment:read` | `Assignment[]` |
| `GET /drivers/{driver_id}/assignments` | Driver assignment history | `assignment:read` | `Assignment[]` |
| `GET /attendance` | The day's roster | `attendance:read` | `date` (default `today`), `depot_id`, `driver_id`, `status`, `search` -> paged `RosterEntry[]` |
| `POST /attendance` | Record attendance | `attendance:write` | `driver_id,date,status`; 409 duplicate; `Idempotency-Key` |
| `GET /attendance/{attendance_id}` | Attendance detail | `attendance:read` | `Attendance` |
| `PUT /attendance/{attendance_id}` | Replace status and notes | `attendance:write` | `{status,notes?}` -> `Attendance` |
| `PATCH /attendance/{attendance_id}` | Update attendance | `attendance:write` | `AttendanceUpdate` -> `Attendance` |

A driver's `depot_id` is their home depot, stored once on the driver's user account (`auth.users.depot_id`). `POST /drivers` and `PATCH /drivers` write it there, and `GET /drivers?depot_id=` filters through it.

Driver rules (FMS-16):

- **`Driver`:** `id`, `user_id`, `full_name`, `email`, `phone`, `depot_id`, `license_number`, `license_categories`, `license_expiry` (`YYYY-MM-DD`), `license_status` (`valid`, `expiring_soon` within 30 days, or `expired`, by today's date in Addis Ababa), `hire_date`, `emergency_phone`, `status` (`active` or `retired`), `version`, `created_at`, `updated_at`. Name, email and phone are the user account's and change through user administration, not here. Licence and phone are personal data: every driver endpoint needs `driver:read` or more.
- **`POST /drivers`:** `user_id` must be an active account with the `driver` role, in the caller's depots (or without a depot yet); otherwise `400 VALIDATION_FAILED` on `user_id` with `references_missing_record`, `account_not_active` or `not_a_driver`. Also required: `license_number`, `license_expiry`, `depot_id`; optional `license_categories`, `hire_date` (not in the future), `emergency_phone`. A second driver for the same account is `409 CONFLICT_DUPLICATE` on `user_id`.
- **`POST /drivers` with a new account (FMS-19):** instead of `user_id`, send `account: { full_name, email, phone? }` (exactly one of the two, else `400` on `user_id` with `user_id_or_account`). The account is created in the same transaction, with the `driver` role, the given home depot and **no password**: it cannot sign in until one is set through user administration (a later card). The email is stored trimmed and lower case; one already in use is `409 CONFLICT_DUPLICATE` on `account.email`. A refused licence (`409 CONFLICT_DUPLICATE_LICENSE`) leaves no account behind. Audit: one row for the account, one for the driver.
- **Current trip:** every `Driver` carries `current_trip` (`assigned` or `en_route`, en route first) as `{ id, status, origin, destination, scheduled_start }`, or `null`, like a `Vehicle` (§6.2).
- **Licence number** is stored trimmed, upper case, single-spaced; a duplicate is `409 CONFLICT_DUPLICATE_LICENSE` whatever its case or spacing.
- **`license_categories`** lists the European licence categories held (EU Directive 2006/126/EC): `AM`, `A1`, `A2`, `A`, `B1`, `B`, `BE`, `C1`, `C1E`, `C`, `CE`, `D1`, `D1E`, `D`, `DE`; stored without duplicates in that order, `[]` when not recorded. Anything else is `400 VALIDATION_INVALID_ENUM`. A vehicle is allowed when any held category allows its type (A* motorcycle, B/BE car, SUV, van, C* truck, D* bus, B1 other); the table is `LICENSE_CATEGORY_VEHICLE_TYPES` in the fleet module.
- **`PATCH /drivers/{id}`:** any non-empty subset of the licence fields, `emergency_phone` and `depot_id`; `user_id` is fixed. A retired driver cannot be changed (`409 CONFLICT_INVALID_STATE_TRANSITION`); reinstate them first.
- **Concurrency** (§19), drivers and vehicles: `version` is bumped on every change (a driver's depot move included) and returned as the `ETag` of `GET`, `POST` and `PATCH`. A `PATCH` with `If-Match: "<version>"` for an older version is refused with `409 CONFLICT_CONCURRENT_MODIFICATION`; a malformed `If-Match` is `400`. Without `If-Match` the change goes through (last write wins); clients that edit should send it.
- **Depot scope:** as for vehicles. A driver whose account is outside the caller's depots is `404`; a `depot_id` outside them is `400 references_missing_record`.
- **Retirement** sets `is_active = false` (one audit row), keeps trips and attendance, and leaves the user account as it is. It is refused with `409 CONFLICT_DRIVER_IN_USE` while the driver is on an `assigned` or `en_route` trip or has an active vehicle assignment. Retiring a retired driver returns `204` and changes nothing.
- **List:** `license_expiring_before=YYYY-MM-DD` returns licences expiring before that date (already expired included). `search` matches name, email or licence number. `status` (`active` default, or `retired`), `page`/`page_size` as §18, `sort_by` `license_number` (default), `full_name`, `license_expiry`, `hire_date` or `created_at`. Name, email and depot are matched on the fleet module's copy of the account fields (`fleet.driver_accounts`), refreshed in the same transaction when the driver API changes an account, on `UserAccountChanged` from other modules, and daily.
- **`POST /drivers/import`:** a CSV (`Content-Type: text/csv`, at most 500 rows, 1 MB) with a header row naming its columns: `email` (the account), `license_number`, `license_expiry`, `depot_code` or `depot_id`, and optional `license_categories` (one cell, separated by spaces, commas, semicolons or bars), `hire_date`, `emergency_phone`. Every row goes through the `POST /drivers` rules, and rows are checked against each other (`duplicate_of_row_<n>`). If any row fails, nothing is saved and the response is `400 VALIDATION_FAILED` with one detail per problem, `field` being `rows.<row>.<column>` (the header is row 1). Success is `201` with `{ created: [{ row, id }] }`; `?dry_run=true` checks everything, saves nothing and returns `200` with `{ valid: <rows> }`.
- **Eligibility** (for trip assignment): the fleet module's `checkDriverEligibility(driverId, at, { vehicleId })` returns `{ eligible, reasons }`. Reasons: `driver_not_found`, `driver_retired`, `account_not_active`, `license_expired` (on `at`'s date in Addis Ababa), and with a vehicle `license_category_missing`, `license_category_not_valid_for_vehicle` or `vehicle_not_found`. Assignment should return them in its `409` details so the dispatcher sees why. `isDriverEligible` is the yes/no shortcut.
- **Events:** `DriverRegistered`, `DriverRetired` and `DriverReinstated`, with `driver_id`, `user_id` and `depot_id` (public ids). `DriverUpdated` adds `changed_fields` (licence or contact fields); `DriverTransferred` adds `from_depot_id` and `to_depot_id` (a home-depot move). `LicenceExpiring` (with `user_id`, `depot_id`, `license_expiry`, `days_left` and `level`: `amber` within 30 days, `red` within 7) comes from the daily expiry check (07:00 Addis Ababa, FMS-26), once per level and expiry date (see [jobs.md](jobs.md)). Attendance `status` is one of `present`, `absent`, `on_leave`, `late`, `sick`, `other`; the recording user is taken from the session.

Attendance rules (FMS-21):

- **Who:** `attendance:read` reads, `attendance:write` writes: admin, fleet manager and depot admin for the drivers homed in their depots; a dispatcher reads only (`403` on writes). A driver may read and record only their own day. A driver outside the caller's depots is `400 references_missing_record` on `driver_id` (write) or `404` (by id).
- **Days:** `date` is a calendar day in Addis Ababa; `today` in a query means that. `present`, `absent`, `late` and `sick` are recorded for today or earlier (`400`, `reason: "in_future"`); `on_leave` and `other` can be booked up to 60 days ahead (`too_far_ahead` beyond).
- **One per driver and day:** a second `POST` is `409 CONFLICT_ATTENDANCE_DUPLICATE`; change the record with `PUT` (status, notes) or `PATCH`. A retired driver is `409 CONFLICT_INVALID_STATE_TRANSITION`. `logged_by` is whoever wrote last; each write is one audit row.
- **`Attendance`:** `id`, `driver_id`, `date`, `status` (`present`, `absent`, `on_leave`, `late`, `sick`, `other`), `notes` (up to 500), `logged_by`, `logged_by_name`, `created_at`, `updated_at`.
- **Roster:** `GET /attendance` returns every active driver the caller may see (home depot in scope and still active), by name, each with the day's `attendance` or `null`: `{ driver_id, full_name, email, depot_id, license_status, date, attendance }`. `status=unmarked` lists drivers without a record. Paged (§18); `meta.date` is the day shown.
- **Dispatch warning:** every `Driver` carries `attendance_today`; `absent`, `on_leave` and `sick` are a warning in dispatch (FMS-33), not a block.
- **Events:** `AttendanceRecorded` with `attendance_id`, `driver_id`, `date`, `status` and `previous_status` (null on create).

### 6.4 DVIR

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /dvir` | Legacy-compatible DVIR command | `dvir:write` | Same body, behaviour and `Idempotency-Key` as `POST /dvir-reports` |
| `POST /dvir-reports` | Canonical DVIR create | `dvir:write` | `vehicle_id,type,items`; optional `trip_id`, `driver_id`, `issues_found`, `submitted_at` -> `201 DVIRReport` (`meta.created: true`), or `200` with the original and `meta.created: false`; `Idempotency-Key` |
| `GET /vehicles/{vehicle_id}/dvir-reports` | DVIR history | `dvir:read` | `type`, `issues_found`, `from`, `to`, `sort_order` (`desc` default) -> paged `DVIRReport[]` |

DVIR rules (FMS-36):

- **`DVIRCreate`:** `type` is `pre_trip`, `post_trip`, `routine` or `other` (anything else is `400 VALIDATION_INVALID_ENUM`). `items` is the checklist: 1 to 100 entries `{name, passed, notes?}`, a name at most once (any casing; `reason: "duplicate_item"`). `issues_found` is the driver's own answer; any item with `passed: false` forces it `true`, and `true` with every item passed is kept. `submitted_at` is when the driver pressed submit (an offline queue may be late): defaults to now, never in the future (`reason: "in_future"`, 5 minutes of clock drift allowed) and not older than 30 days (`reason: "too_old"`). Any other field is `not_writable`.
- **`DVIRReport`:** `id`, `vehicle_id`, `driver_id`, `trip_id`, `type`, `status` (`submitted`), `items`, `defects` (the failed items, `{name, notes}`), `issues_found`, `submitted_at`, `created_at`. A report is never edited or deleted here.
- **Issues found:** `issues_found: true` sets the vehicle's `maintenance_flag` in the same transaction as the report (one audit trail for both) and publishes `VehicleFaultDetected`. The vehicle is flagged, not locked: a technician reviews and clears the flag. A later clean inspection does not clear it.
- **Duplicates:** with a `trip_id`, an inspection of one type is recorded once per vehicle and trip. Submitting it again (an offline replay) answers `200` with the original report and `meta.created: false`, even if the second checklist differs, and changes nothing. Without a trip there is nothing to match on. `Idempotency-Key` (§19) additionally replays the exact stored response.
- **Who:** `dvir:write` is held by admin, fleet manager, depot admin, technician and driver. A driver always submits as themselves (`driver_id` omitted or their own; another is `400`, `reason: "not_writable"`), for vehicles of their depot, and reads only their own reports. Everyone else names the driver the inspection is for (`400`, `reason: "required"`; a driver outside their depots is `references_missing_record`). A driver without a driver profile cannot submit.
- **Vehicle and trip:** the vehicle must be a live vehicle in the caller's depots (`400`, `field: "vehicle_id"`, `references_missing_record` or `vehicle_retired`). `trip_id` must be a trip the caller may see (a driver's own; staff their depots') and, if it has a vehicle, this one (`reason: "trip_vehicle_mismatch"`).
- **History:** `GET /vehicles/{id}/dvir-reports` is `404` for a vehicle outside the caller's depots (the same body as a missing id); a driver gets their own reports of it. `from` and `to` are Addis Ababa days (as in §3), and `to` includes its whole day.

## 7. Trips and Routes API

### 7.1 Routes

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /routes` | List/search routes | `route:read` | Paged `Route[]` |
| `POST /routes` | Create route | `route:write` | `RouteCreate` -> `Route` |
| `GET /routes/{route_id}` | Get route | `route:read` | `Route` |
| `PATCH /routes/{route_id}` | Update route | `route:write` | `RouteUpdate` -> `Route` |

Route rules (FMS-83):

- **Who:** `route:read`: every staff role except the finance clerk, and drivers (for their trips). `route:write`: admin, fleet manager, dispatcher, depot admin. Depot scope applies to reads and writes: a depot's dispatcher never sees, reads (`404`) or changes another depot's routes, and cannot create one there (`400 references_missing_record`).
- **Create:** `name` (1-255, unique among the depot's active routes, case-insensitive: `409 CONFLICT_DUPLICATE` with field `name`) and `depot_id` are required; a route without a depot is `400 VALIDATION_FAILED`. Optional: `origin_name`, `origin` (`{latitude, longitude}`), `destination_name`, `destination`, `stops` (up to 25, in travel order: `[{name, latitude, longitude}]`, a stop's point optional but both parts or neither), `distance_km` (0-100,000, at most 3 decimals), `estimated_duration_seconds` (0-30 days). Latitude is -90 to 90 and longitude -180 to 180, at most 6 decimals. Distance and time are entered by hand until the mapping adapter (FMS-84) measures them.
- **`Route`:** `id`, `name`, `depot_id`, `origin_name`, `origin`, `destination_name`, `destination`, `stops[]`, `distance_km`, `estimated_duration_seconds`, `is_active`, `version` (ETag; `If-Match` on `PATCH`, `409 CONFLICT_CONCURRENT_MODIFICATION` when stale), `created_at`, `updated_at`.
- **Update:** `PATCH` takes the fields sent (an empty body is `400`); `null` clears an optional field; `stops` replaces the whole list. A `PATCH` that changes nothing writes no audit row and publishes nothing.
- **Retire:** `PATCH {"is_active": false}`. Routes are never deleted: a retired route leaves the default list (`status=active`) and is not offered for new trips, while trips that used it keep their reference and their own copy of the plan (origin, destination, planned distance, stops). Its name is free for a new route; `{"is_active": true}` restores it unless the name has been taken (`409`).
- **List:** `GET /routes` filters by `depot_id`, `search` (name, origin, destination), `status` (`active` default, `retired`, `all`); sorts by `name` (default), `distance_km` or `updated_at` (`sort_order`). Paged (§18).
- **Events:** `RouteCreated` (`route_id`, `depot_id`, `name`, `distance_km`) and `RouteUpdated` (`route_id`, `depot_id`, `changed_fields`, `is_active`), ordered per route (FMS-73).

### 7.2 Trips

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /trips` | Search trips | `trip:read` | filters + paging -> `Trip[]` |
| `POST /trips` | Create trip | `trip:write` | route/vehicle/driver or scheduling data; `Idempotency-Key` |
| `GET /trips/{trip_id}` | Get trip | `trip:read` | `Trip` |
| `PATCH /trips/{trip_id}` | Update trip | `trip:write` | `TripUpdate` -> `Trip` |
| `POST /trips/{trip_id}/assign` | Assign driver and vehicle | `trip:assign` | Runs overlap + vehicle maintenance/flag rules; 409 conflicts |
| `POST /trips/{trip_id}/start` | Start trip | `trip:execute` | Valid state transition -> `Trip`; `If-Match`, `Idempotency-Key`; `meta.warnings` |
| `POST /trips/{trip_id}/end` | End trip | `trip:execute` | Valid state transition -> `Trip`; `If-Match`, `Idempotency-Key` |
| `POST /trips/{trip_id}/status` | Explicit status transition | `trip:execute` | `{status}`; `scheduled/assigned/en_route/completed/cancelled`; `If-Match`, `Idempotency-Key` |
| `POST /trips/{trip_id}/stops/{stop_id}/complete` | Complete trip stop | `trip:execute` | Stop completion -> `TripStop` |
| `GET /trips/{trip_id}/live` | Live trip state | `trip:read` | `TripLiveState` |

Trip assignment preserves the earlier business rules: a driver cannot be assigned to overlapping trips; a vehicle cannot be assigned to overlapping trips; and a vehicle with an active maintenance/operational flag cannot be assigned when the domain rule forbids it. Typical conflicts are `409 CONFLICT_DRIVER_OVERLAP`, `409 CONFLICT_VEHICLE_OVERLAP` and `409 CONFLICT_VEHICLE_FLAGGED`.

The overlap rules hold for any write that puts a trip into `assigned` or `en_route`, including `POST /trips` and `PATCH /trips` with a driver or vehicle, not only `/assign`. The database enforces them as well (`ex_trip_driver_overlap`, `ex_trip_vehicle_overlap`), so two concurrent assignments cannot both succeed. `trip:assign` is separate from `trip:execute` so drivers can start and end their trips without being able to assign trips.

Trip rules (FMS-30):

- **Who:** `trip:read`: every staff role except the finance clerk and technician, and drivers. Staff see the trips of their depots (a trip's depot is its route's depot); a driver sees **only the trips they drive**: other trips are `404`, and filtering by another driver returns an empty list, not `403`. `trip:write` (create, reschedule, cancel): admin, fleet manager, dispatcher.
- **Create:** `route_id` (an active route in your depots: unknown or elsewhere is `400 references_missing_record`, retired is `400 route_retired`), `scheduled_start` and `scheduled_end` (ISO 8601 with an offset). An end at or before the start is `400 VALIDATION_INVALID_DATE_RANGE`. The trip starts `scheduled`, with no driver or vehicle (assigned later, FMS-31), and copies the route's plan: `origin`, `destination`, `planned_distance_km`, `planned_duration_seconds` and its stops (as `stops[]`, `status: planned`). A later edit of the route never changes the trip. `Idempotency-Key` is accepted (§19).
- **`Trip`:** `id`, `route_id`, `route_name`, `depot_id`, `vehicle_id`, `driver_id`, `status`, `origin`, `destination`, `planned_distance_km`, `planned_duration_seconds`, `scheduled_start`, `scheduled_end`, `actual_start`, `actual_end`, `actual_distance_km`, `stops[]` (`id`, `sequence_number`, `name`, `latitude`, `longitude`, `status`, `planned_arrival`, `actual_arrival`), `version` (ETag; `If-Match` on `PATCH`), `created_at`, `updated_at`.
- **Update:** `PATCH` takes `scheduled_start`, `scheduled_end` and `status: "cancelled"`; driver, vehicle and route are not writable (re-plan by cancelling and creating). Only an open trip (`draft`, `scheduled`, `assigned`) changes; a draft that gets both times becomes `scheduled`. The overlap rules above still hold when an assigned trip is rescheduled.
- **Cancel:** `PATCH {"status": "cancelled"}` keeps the row with status `cancelled`; it stays in the history. A trip under way (`en_route`) is ended, not cancelled, and a completed or cancelled trip never changes: both `409 CONFLICT_INVALID_STATE_TRANSITION` (`reason: trip_en_route`, `trip_completed`, `trip_cancelled`).
- **History:** `GET /trips` filters by `status` (one or several, comma-separated), `driver_id`, `vehicle_id`, `route_id`, `depot_id`, and `from`/`to` on the trip's start (`scheduled_start`, or `created_at` for an unscheduled draft). `from`/`to` take an instant or a date; a date is that Addis Ababa day, and a date `to` covers the whole day. `to` at or before `from` is `400 VALIDATION_INVALID_DATE_RANGE`. Filters combine (AND); one naming something unknown matches nothing. Newest first (`sort_order=asc` for earliest first) with **keyset paging**: `page_size` 1-100 (default 50), `meta.next_cursor` for the next page or `null` on the last; trips written while paging never shift a page. A cursor the API did not issue is `400 invalid_cursor`.
- **Events:** `TripCreated` (`trip_id`, `route_id`, `depot_id`, `scheduled_start`, `scheduled_end`), `TripUpdated` on a reschedule (`changed_fields`, `status`), `TripCancelled` (`previous_status`, `route_id`, `driver_id`, `vehicle_id`), ordered per trip (FMS-73).

Assignment rules (FMS-31):

- **Who:** `trip:assign` (admin, fleet manager, dispatcher; never drivers). Every assignment is audited.
- **Request:** `POST /trips/{trip_id}/assign` with `{ "driver_id", "vehicle_id", "version" }`. `version` is the one the dispatcher saw and is required: if the trip changed since, `409 CONFLICT_CONCURRENT_MODIFICATION`. `Idempotency-Key` is accepted. A `scheduled` trip becomes `assigned`; an `assigned` trip can be re-assigned. A draft without times, or a trip under way, completed or cancelled, is `409 CONFLICT_INVALID_STATE_TRANSITION`.
- **Checks, in this order:** the vehicle and driver are in your depots (`400 references_missing_record`). Then fleet availability (FMS-76), read in the same transaction after the vehicle and driver rows are locked: the vehicle belongs to the trip's depot (`409 CONFLICT_DEPOT_MISMATCH`), and so does the driver, after the vehicle checks; it is not retired or out of service (`409 CONFLICT_INVALID_STATE_TRANSITION`, `reason: "vehicle_retired"` / `"vehicle_inactive"`); **BR-2** it is not flagged for maintenance or in the workshop (`409 CONFLICT_VEHICLE_FLAGGED`, `record_id` = its open maintenance record, when there is one). The driver is eligible for that vehicle on the trip's start (`409 CONFLICT_DRIVER_NOT_ELIGIBLE`, one detail per reason, §6.3). **BR-1** the driver and **BR-3** the vehicle are not on another `assigned` or `en_route` trip that overlaps (`409 CONFLICT_DRIVER_OVERLAP` / `CONFLICT_VEHICLE_OVERLAP`, `record_id` = that trip), checked on the trips themselves.
- **Depot:** a trip is staffed from its own depot, whoever assigns it: a fleet manager or admin who sees every depot still cannot put another depot's vehicle or driver on it. To lend one, move it to that depot first.
- **A 0-minute gap is an overlap:** a trip ending at 08:00 and the next starting at 08:00 conflict. The database enforces the same rule (`ex_trip_driver_overlap`, `ex_trip_vehicle_overlap`, both ends included since migration 030), so two concurrent assignments can never both succeed: one gets `200`, the other `409` (when the database refuses it, the `409` has no `record_id`).
- **Overrun warning:** if the driver or vehicle is on a trip still under way whose expected end (its scheduled end, or now if it is already late) plus `TRIP_OVERRUN_GRACE_MINUTES` (default 0) is after this trip's start, the assignment still succeeds, with `meta.warnings: [{ warning: "PREVIOUS_TRIP_OVERRUN", field, trip_id, expected_end }]`. It never blocks assignment or start.
- **Attendance warning:** a driver marked `absent`, `on_leave` or `sick` on the trip's first day (Addis Ababa) is still assigned, with `meta.warnings: [{ warning: "DRIVER_ATTENDANCE", field: "driver_id", attendance }]` (FMS-21, through fleet availability).
- **Response:** `200` with the `Trip` (new `version` and ETag) and `meta.warnings` (empty when none). Assigning the same driver and vehicle again changes nothing.
- **Event:** `TripAssigned` (`trip_id`, `driver_id`, `vehicle_id`, `previous_driver_id`, `previous_vehicle_id`, `route_id`, `depot_id`, `scheduled_start`, `scheduled_end`). Live updates to screens (Socket.IO) arrive in Sprint 4 from this event.

Trip lifecycle (FMS-32):

- **States:** `draft` → `scheduled` → `assigned` → `en_route` → `completed`; `cancelled` from `draft`, `scheduled` or `assigned`. `completed` and `cancelled` are final. A trip under way is ended, never cancelled. Nothing moves back to `draft`.
- **Refusal:** a move the table does not allow is `409 CONFLICT_INVALID_STATE_TRANSITION` with `details: [{ field: "status", reason: "<from>_to_<to>", allowed_transitions: [...] }]` (empty for a final state). Starting a `scheduled` trip says `allowed_transitions: ["assigned", "cancelled"]`.
- **Who:** `trip:execute` (admin, fleet manager, dispatcher, driver). A driver moves only the trips they drive (others are `404`). Scheduling a draft and cancelling are dispatch decisions and also need `trip:write`: a driver gets `403 FORBIDDEN_INSUFFICIENT_ROLE`.
- **Start** (`POST /trips/{id}/start`, or `/status` with `en_route`): `assigned` → `en_route`, `actual_start` = now. The assignment rules are read again, since things may have changed: the vehicle flagged (a pre-trip inspection), in the workshop, out of service, retired or moved to another depot, or the driver's licence expired, refuse the start with the same `409`s as assignment. Another trip of the driver or vehicle still under way is a warning (`PREVIOUS_TRIP_OVERRUN`), and so is the driver's attendance (`DRIVER_ATTENDANCE`), in `meta.warnings`.
- **End** (`POST /trips/{id}/end`, or `/status` with `completed`): `en_route` → `completed`, `actual_end` = now (never before `actual_start`), and the actual duration is stored.
- **`/status`:** `{ "status" }` is one of `scheduled` (a draft with both times; without them `409`, `reason: "schedule_required"`), `assigned` (always `409`, `reason: "assign_required"`: use `POST /trips/{id}/assign`, which runs the assignment rules), `en_route` (start), `completed` (end), `cancelled`. `draft` or anything else is `400`.
- **Requests:** start and end take no body (`{}` or none; any field is `400`). All three take `If-Match` (a trip changed since is `409 CONFLICT_CONCURRENT_MODIFICATION`) and `Idempotency-Key` (a retry replays the first answer). Every move is audited.
- **Events:** `TripStarted` (`trip_id`, `driver_id`, `vehicle_id`, `route_id`, `depot_id`, `scheduled_start`, `actual_start`), `TripCompleted` (the same, with `actual_end` and `duration_seconds`), `TripCancelled` (as for `PATCH`), and `TripUpdated` (`changed_fields: ["status"]`) when a draft is scheduled. Fleet's availability and the cached vehicle follow them.

### 7.3 Trip creation example

```http
POST /api/v1/trips
Idempotency-Key: 9d0f...

{
  "route_id": "uuid",
  "scheduled_start": "2026-10-05T08:00:00Z",
  "scheduled_end": "2026-10-05T10:30:00Z"
}
```

## 8. Document API

Documents are used for operational attachments such as registration records, licence documents, maintenance invoices, inspection evidence, incident photos, and DVIR attachments. Storage is outside PostgreSQL table storage; PostgreSQL stores metadata and references.

### 8.1 Documents

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /documents` | Upload document | `document:write` | `multipart/form-data`; jpeg/png/pdf; max 10 MB -> `201 Document` |
| `GET /documents?owner_type=&owner_id=` | List an owner's documents | `document:read` | Up to 100 owner ids, comma-separated -> `Document[]` |
| `GET /documents/{document_id}` | Get document access | `document:read` | Returns metadata + time-limited signed URL |
| `GET /documents/{document_id}/content` | Download the file | Signed URL (no session) | `?expires=&signature=` from `url` -> the file |
| `DELETE /documents/{document_id}` | Retire/delete document | `document:delete` | 204; subject to retention policy |

Document rules (FMS-17):

- **Upload form:** the file is the `file` part (one file); the other parts are `owner_type` (`vehicle` or `driver`), `owner_id` (the owner's public id), `document_type` (`registration`, `licence`, `insurance`, `maintenance_invoice`, `inspection_evidence`, `incident_photo`, `dvir_attachment`, `fuel_receipt`, `other`) and, optionally, `expires_on` (the document's own expiry, e.g. an insurance end date) and `retain_until` (how long the file must be kept), both `YYYY-MM-DD`. Any other part is `400 VALIDATION_FAILED` (`reason: "not_writable"`); a body that is not readable multipart is `400` with `field: "body"`, `reason: "malformed_multipart"`.
- **File checks:** the type is judged from the file's first bytes, not its name or the declared `Content-Type`: JPEG, PNG or PDF, anything else (a `.txt` renamed `.pdf`, say) is `415 UNSUPPORTED_MEDIA_TYPE`. A file over 10 MB is `413 PAYLOAD_TOO_LARGE`; the server stops reading at the limit. The stored `content_type`, `size_bytes` and `sha256` are computed by the server.
- **Owner:** the caller must be able to read the owner. A vehicle needs `vehicle:read` and the vehicle's depot in the caller's scope; a driver needs `driver:read` and the driver's home depot in scope, or to be that driver (a driver uploads and reads their own licence). An owner the caller cannot read, or that does not exist, is `400 VALIDATION_FAILED` with `field: "owner_id"`, `reason: "references_missing_record"`. The same rule decides reads and deletes: a document whose owner is out of scope is `404`, as if it did not exist.
- **Listing:** `GET /documents?owner_type=vehicle&owner_id=a,b,c` (or `owner_type=driver`) returns the live documents of those owners (one page of a vehicle or driver list: 1 to 100 ids), soonest `expires_on` first, then newest; without `url` (ask `GET /documents/{id}` for a link). Owners the caller cannot read are left out, as if they had none, so the answer reveals nothing about them. Not paged: the owner count bounds it (FMS-18).
- **`Document`:** `id`, `owner_type`, `owner_id`, `document_type`, `original_filename` (the name only, without directories or control characters), `content_type`, `size_bytes`, `sha256`, `expires_on`, `retain_until`, `uploaded_by` (user public id), `uploaded_at`. `GET /documents/{document_id}` adds `url` and `url_expires_at`. Where the file is stored is never returned.
- **Signed URL:** `url` is valid for one hour and needs no session, so it can go in an `<img>` or a download link; it names one document and an expiry, signed with HMAC-SHA256 on the server. A link past its expiry is `401 AUTH_TOKEN_EXPIRED`; a changed or missing signature or expiry is `401 AUTH_TOKEN_INVALID`; a link to a deleted document is `404`. The file is sent with its sniffed `Content-Type`, `Content-Disposition: inline` with the original name, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`. Fetch a fresh link from `GET /documents/{document_id}` when one expires.
- **Storage:** files are stored under random keys, outside any web root: on local disk in development (`STORAGE_DRIVER=local`, `STORAGE_LOCAL_DIR`), in S3-compatible object storage elsewhere (`STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_ENDPOINT` for MinIO and `S3_REGION`). A file is never overwritten.
- **Delete:** soft. `DELETE` marks the document deleted (`deleted_at`, `deleted_by`, one audit row) and returns `204`; it then reads as `404` and its links stop working. The file itself is kept for retention (`retain_until`); purging it is a later job.
- **Events:** `DocumentUploaded`, with `document_id`, `owner_type`, `owner_id`, `document_type` and `expires_on`. `DocumentExpiring` (the same ids plus `expires_on`, `days_left` and `level`: `amber` within 30 days of `expires_on`, `red` within 7) comes from the daily expiry check (07:00 Addis Ababa) and at once on upload when the date is already that close; once per level and expiry date (FMS-26, [jobs.md](jobs.md)).

## 9. Fuel Tracking and Reconciliation API

### 9.1 Fuel logs and anomalies

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /fuel-logs` | Record fuel event | `fuel:write` | `vehicle_id,quantity_ml,total_cost_cents,odometer_km`; optional `trip_id`, `driver_id`, `fuel_type` (defaults to the vehicle's), `unit_price_cents`, `station_name`, `fueled_at` (FMS-115) -> `201 FuelLog`; `Idempotency-Key`; integer ml and cents |
| `GET /fuel-logs` | Search fuel history | `fuel:read` | `vehicle_id`, `driver_id`, `trip_id`, `from`, `to`, `sort_order` (`desc` default) -> paged `FuelLog[]` |
| `GET /fuel-logs/{fuel_log_id}` | Get a fuel log | `fuel:read` | `FuelLog`; `404` outside your scope |
| `GET /vehicles/{vehicle_id}/fuel-summary` | Fuel efficiency summary (FMS-41) | `fuel:read` | `from`, `to` (default: the 30 days to now) -> `FuelSummary`; `404` outside your depots and for a driver |
| `GET /fuel-anomalies` | List anomalies (FMS-42) | `fuel-anomaly:read` | `status` (one or several, comma-separated), `vehicle_id`, `anomaly_type`, `page`, `page_size` -> paged `FuelAnomaly[]`, newest detected first |
| `GET /fuel-anomalies/{anomaly_id}` | Anomaly detail (FMS-42) | `fuel-anomaly:read` | `FuelAnomaly`; `404` outside your depots |
| `POST /fuel-anomalies/{anomaly_id}/resolve` | Close an anomaly (FMS-42) | `fuel-anomaly:write` | `outcome` (`resolved` default, or `dismissed`), `notes` (required to dismiss, up to 2,000 characters) -> `FuelAnomaly` |

Fuel log rules (FMS-39):

- **Who:** drivers hold `fuel:read` and `fuel:write` and are limited by scope, not permission. A driver records only for themselves (`driver_id` is theirs; naming another driver is `400`, `reason: "not_writable"`), only for vehicles of their depot, and lists and fetches only their own logs. Another driver's log by id is `404 NOT_FOUND`, the same body as a missing id. Staff (`admin`, `fleet_manager`, `fleet_owner` and `compliance_officer` see every depot; `depot_admin` and `finance_clerk` their own) see the logs of their depots' vehicles. A driver without a driver profile sees nothing and cannot log.
- **`FuelLog`:** `id`, `vehicle_id`, `driver_id` (null when a clerk logs a purchase for nobody), `trip_id`, `fuel_type`, `quantity_ml`, `unit_price_cents`, `total_cost_cents`, `odometer_km`, `station_name`, `source` (`manual`), `recorded_at` (when the fill-up happened), `created_at` (when the server received it). `source` is the server's, and `recorded_at` is written through `fueled_at`: both are `not_writable` like any other unknown field. A log is never edited or deleted.
- **Time (FMS-115):** `fueled_at` (ISO with offset) is when the fill-up happened. The driver form (S-14) sends the moment the driver pressed submit, so a fill-up queued offline in a dead zone is recorded at its pump time, not at sync time. It is stored as `recorded_at`; without it the log is recorded when received. More than 5 minutes ahead of the server (clock drift allowed) is `400`, `field: "fueled_at"`, `reason: "in_future"`; more than 30 days ago is `reason: "too_old"`, as a DVIR's `submitted_at`. Lists sort and filter by `recorded_at`.
- **Values:** `quantity_ml` is a whole number from 1 to 2,000,000 and `total_cost_cents` from 0 to 100,000,000; a fraction (`23500.5`) in any ml or cents field, by any name, is `400 VALIDATION_FLOAT_IN_MONEY_PATH`, and a value outside the range is `400 VALIDATION_FAILED` with `reason: "out_of_range"`. `odometer_km` is required, not negative, with at most one decimal.
- **Odometer:** a reading never goes down with time. One below the vehicle's odometer, or below a fuel log recorded at or before this fill-up's time, is `409 CONFLICT_ODOMETER_REGRESSION` (`reason: "below_last_reading"`) and records nothing; the same reading is fine. A back-dated fill-up (FMS-115) may read lower than logs recorded after it, but not higher: that is `409`, `reason: "above_later_reading"`. The vehicle row is locked while the log is checked, so two logs cannot both pass against the same reading.
- **Vehicle and fuel type:** the vehicle must be a live vehicle in the caller's depots (`400`, `field: "vehicle_id"`, `reason: "references_missing_record"` for one that is missing or elsewhere, `vehicle_retired` for a retired one). An electric vehicle takes no fuel log (`400`, `field: "fuel_type"`, `reason: "not_a_liquid_fuel"`); `fuel_type` defaults to the vehicle's.
- **Trip:** `trip_id`, if sent, must be a trip the caller may see (a driver's own; staff their depots') and, if the trip has a vehicle, this one (`400`, `reason: "trip_vehicle_mismatch"`).
- **Retries:** `Idempotency-Key` (§19) makes a retried POST return the first log with `Idempotent-Replayed: true`; without a key two identical bodies are two fill-ups.
- **Event:** `FuelLogged` (after commit, ordered per vehicle) carries `fuel_log_id`, `vehicle_id`, `driver_id`, `trip_id`, `fuel_type`, `quantity_ml`, `total_cost_cents`, `odometer_km`, `previous_odometer_km` (the highest reading before this one in time, null for a vehicle's first), `recorded_at` (when the fill-up happened) and `created_at` (when it was received). The anomaly rules (FMS-82) read it.
- **Vehicle odometer:** a fuel log does not change `fleet.vehicles.odometer_km`; the vehicle's own odometer changes through the vehicle API.

Fuel anomaly rules (FMS-42):

- **Who:** reading needs `fuel-anomaly:read` (admin, fleet manager, depot admin, finance clerk, compliance officer), closing `fuel-anomaly:write` (admin, fleet manager, finance clerk). Rows are the anomalies of the caller's depots' vehicles; another depot's anomaly is `404`, and a driver sees none.
- **`FuelAnomaly`:** `id`, `vehicle_id`, `registration_number`, `depot_id`, `depot_name` (named here: a finance clerk may not read vehicles or depots), `fuel_log_id` (the fill-up a per-event rule flagged, FMS-82; null for a month's reconciliation), `anomaly_type`, `severity`, `status` (`open`, `reviewed`, `dismissed`, `resolved`), `period_from` and `period_to` (a reconciliation's month), `distance_km`, `expected_ml`, `actual_ml`, `deviation_pct` (whole percent), `detected_at`, `reviewed_by` and `reviewed_by_name` (who closed it), `reviewed_at`, `notes`.
- **Closing:** `resolved` means it was real and dealt with, `dismissed` that it was not a problem, which needs a `notes` saying why (`400`, `field: "notes"`, `reason: "required_to_dismiss"`). Closing records who and when (`reviewed_by`, `reviewed_at`) and is audited. Only an `open` or `reviewed` anomaly can be closed; one already closed is `409 CONFLICT_INVALID_STATE_TRANSITION` (`reason: "already_closed"`). The row is locked while it is closed, so two people closing it at once cannot both succeed.
- **Read from the primary**, not the replica: the screen shows a resolution the moment it is saved.

### 9.2 Fuel reconciliation

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /fuel-reconciliation` | Actual vs expected fuel usage (FMS-41) | `analytics:read` and `fuel:read` | `vehicle_id`, `depot_id`, `from`, `to` (default: last calendar month), `status`, `page`, `page_size` -> paged `FuelReconciliation[]`, furthest from expected first; `meta` adds `from`, `to`, `threshold_pct` and `summary` |

`fuel.fuel_logs` stores raw observations. `fuel.fuel_anomalies` stores derived findings. Reconciliation compares actual consumption with expected consumption using trip distance, vehicle efficiency and configured rules. The API must reject floating-point values in money paths; use integer minor units such as cents.

Reconciliation rules (FMS-41, [fuel-reconciliation.md](fuel-reconciliation.md)):

- **Figures:** for each vehicle and period, the distance of its completed trips (`actual_distance_km`, by `actual_end`), the fuel that distance needs at the vehicle's `fuel_efficiency_ml_per_km` (`expected_ml`), the fuel logged (`actual_ml`, by `recorded_at`) and `variance_pct = (actual - expected) / expected`. Integers end to end: distance in metres, fuel in ml, money in cents, the variance in whole percent, each division rounded half away from zero. Nothing passes through a float.
- **Judgement:** more than `FUEL_VARIANCE_THRESHOLD_PCT` (default 20) above expected is `above`; more than it below is `below`; otherwise `within` (exactly 20% is within). An electric vehicle, one without a rating, or under 100 km of trips is `not_judged`, with `reason` `electric`, `no_efficiency` or `too_little_distance`.
- **Who:** `GET /fuel-reconciliation` needs both permissions: a driver (`fuel:read` only) and a dispatcher (`analytics:read` only) get `403`. Rows are the caller's depots' vehicles; a `vehicle_id` or `depot_id` outside them, or unknown, gives an empty page. `GET /vehicles/{vehicle_id}/fuel-summary` needs `fuel:read` in the depot scope; a driver gets `404` for every vehicle, as its totals include other drivers' fill-ups.
- **Period:** `from` and `to` are instants, or dates meaning Addis Ababa days (`to` inclusive). One bound alone: `from` runs to now, `to` covers the 30 days before it. At most 366 days (`400`, `reason: "period_too_long"`); `to` must be after `from` (`reason: "before_from"`).
- **`FuelReconciliation`:** `vehicle_id`, `registration_number`, `depot_id`, `depot_name`, `fuel_type`, `fuel_efficiency_ml_per_km`, `distance_km`, `trips`, `fuel_logs`, `expected_ml`, `actual_ml`, `variance_ml`, `variance_pct`, `total_cost_cents`, `status`, `reason`, `anomaly_id` (the anomaly the monthly job raised for exactly this period). `meta.summary`: `vehicles`, `judged`, `above`, `below`, `expected_ml` and `actual_ml` (judged vehicles), `variance_pct`, `total_cost_cents` (every vehicle).
- **`FuelSummary`:** `vehicle_id`, `from`, `to`, `fuel_logs`, `actual_ml`, `total_cost_cents`, `trips`, `distance_km`, `rated_efficiency_ml_per_km`, `actual_efficiency_ml_per_km`, `expected_ml`, `variance_ml`, `variance_pct`, `status`, `reason`, `cost_per_km_cents`, `average_price_cents_per_litre`, `open_anomalies`, `threshold_pct`.
- **Read from the replica** when it is up (FMS-94), the monthly job too. Both endpoints return `meta.data_freshness` (FMS-94, [read-replica.md](read-replica.md)): `source` (`replica` or `primary`), `lag_seconds` (how far the data may be behind the primary; 0 from the primary) and `as_of` (now less the lag).
- **The API only reads.** The monthly job `fuel-reconciliation` (04:30 daily, last calendar month) writes a `fuel.fuel_anomalies` row for each vehicle above or below (`consumption_above_expected` or `consumption_below_expected`; severity `high` beyond twice the threshold, else `medium`), once per vehicle and month, and publishes `FuelAnomalyDetected`.

## 10. Maintenance, Inventory and Predictive Maintenance API

### 10.1 Maintenance and inventory

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /maintenance` | Legacy-compatible maintenance list | `maintenance:read` | Paged repair records |
| `POST /maintenance` | Legacy-compatible maintenance create | `maintenance:write` | `vehicle_id,description,labour_hours,cost_cents`; activates maintenance flag |
| `GET /maintenance-records` | Canonical maintenance list | `maintenance:read` | `vehicle_id`, `status`, `open`, `maintenance_type`, `sort_by` (`created_at`, when entered, the default; or `work_date`, when the work happened: completed, else started, else scheduled; FMS-136), `sort_order` (`desc` default) -> Paged `MaintenanceRecord[]` (also `GET /maintenance`) |
| `POST /maintenance-records` | Canonical maintenance create | `maintenance:write` | `MaintenanceRecordCreate` -> `MaintenanceRecord` |
| `GET /maintenance-records/{id}` | Maintenance detail | `maintenance:read` | `MaintenanceRecord` (also `/maintenance/{id}`) |
| `PATCH /maintenance-records/{id}` | Update maintenance | `maintenance:write` | `MaintenanceRecordUpdate` -> `MaintenanceRecord`; `PUT` too (also `/maintenance/{id}`) |
| `POST /maintenance-records/{id}/complete` | Complete work | `maintenance:execute` | Completion metadata; optional `failures[]`; clears maintenance flag when applicable |
| `POST /maintenance-records/{id}/failures` | Record what failed (FMS-125) | `maintenance:write` | `FailureInput` -> `201 FailureEvent` |
| `GET /failure-events` | Recorded failures (FMS-125) | `maintenance:read` | `vehicle_id,component,unplanned,from,to` -> Paged `FailureEvent[]`, newest first |
| `GET /inventory` | Legacy-compatible inventory search | `inventory:read` | `depot_id,below_reorder` -> `InventoryPart[]` |
| `GET /inventory/parts` | Canonical inventory search | `inventory:read` | Paged `InventoryPart[]` |
| `POST /inventory/{part_id}/adjust` | Compatibility stock adjustment | `inventory:write` | Creates inventory movement; resulting stock cannot be negative |
| `POST /inventory` | Create part | `inventory:write` | `InventoryPartCreate` -> `201 InventoryPart` |
| `GET /inventory/{part_id}` | Part detail | `inventory:read` | `InventoryPart` |
| `PUT /inventory/{part_id}` | Update part | `inventory:write` | Fields sent (not stock) -> `InventoryPart`; `If-Match` |
| `GET /inventory/{part_id}/movements` | A part's stock ledger | `inventory:read` | Paged `InventoryMovement[]` |
| `GET /vehicles/{vehicle_id}/service-items` | When each wearing part and fluid was last changed (FMS-52) | `maintenance:read` | `ServiceItem[]`: all 11 items, in a fixed order |
| `POST /inventory/movements` | Record stock movement | `inventory:write` | `InventoryMovement` -> `InventoryMovement` |

Maintenance rules (FMS-22):

- **Paths:** `/maintenance` and `/maintenance-records` are the same API (list, create, read, `PUT`/`PATCH`, `POST .../complete`). Reads need `maintenance:read`; writes `maintenance:write` (technician, depot admin, fleet manager, admin; a dispatcher gets `403`); `POST .../complete` needs `maintenance:execute` (technician, fleet manager, admin). Records are limited to vehicles in the caller's depot scope (`404` otherwise).
- **Create:** `vehicle_id`, `description`, `labour_hours` (at most two decimals) and `total_cost_cents` (whole cents) are required; optional `parts` (`[{part_id, quantity, unit_cost_cents}]`, each part once), `maintenance_type` (default `corrective`), `status` (`scheduled`, `open` (default) or `in_progress`), `priority`, `scheduled_at`, `odometer_km`, `workshop`, `notes`. A fractional number in **any** money-like field (`total_cost_cents`, `unit_cost_cents`, or a stray `totalCost`/`price`/`amount`) is `400 VALIDATION_FLOAT_IN_MONEY_PATH`. A vehicle outside the caller's depots is `400 references_missing_record`; a retired one `409`.
- **Maintenance flag:** creating a record sets the vehicle's `maintenance_flag` in the same transaction. Completing (`completed_at`, `status: completed` or `POST .../complete`) or cancelling it clears the flag in the same transaction, unless other work on the vehicle is still `scheduled`, `open` or `in_progress`. Writes lock the vehicle row, so two completions cannot race the flag. Completed and cancelled records cannot change (`409`).
- **Parts:** each part used is taken off `inventory_parts.stock_quantity`, listed on the record at the cost charged, and written to the inventory ledger (`consumption`, referencing the record). A part must be stocked (`400 references_missing_record`) and shared or in the vehicle's depot (`part_in_other_depot`). Stock never goes below zero (FMS-23): a repair that uses more than the stock record holds is still saved in full, stock stops at 0, and `meta.warnings` includes `{ warning: "LOW_STOCK", part_id, part_number, stock_quantity, shortfall }`. A total below the parts' cost adds `{ warning: "COST_BELOW_PARTS", ... }`.
- **Completion:** `completed_at` is not in the future (5 minutes' clock skew allowed) nor before `started_at`; `completed_by` is the caller. `status: in_progress` sets `started_at`. A `corrective` repair is completed only with at least one failure record (FMS-125): otherwise `400` with `{ field: "failures", reason: "failure_required" }`, and the record stays open.
- **Failures (FMS-125, [maintenance.md](maintenance.md)):** what broke, recorded as `failures` on create, on `POST .../complete` (same transaction) or one at a time on `POST .../failures` (open or completed work; cancelled is `409`). `FailureInput`: `component` and `failure_mode` from fixed catalogues (anything else is `400`), `unplanned` (required), `detected_by` (default `technician`), `occurred_at` (default the repair's opening; not in the future), `odometer_km` (default the repair's), `incident_id` (the same vehicle's: else `incident_other_vehicle`), `notes`. `FailureEvent` adds `id`, `vehicle_id`, `registration_number`, `maintenance_record_id`, `recorded_by`, `created_at`. Never edited.
- **`MaintenanceRecord`:** `id`, `vehicle_id`, `registration_number`, `maintenance_type`, `description`, `status`, `priority`, `scheduled_at`, `started_at`, `completed_at`, `odometer_km`, `labour_hours`, `total_cost_cents`, `parts_cost_cents`, `workshop`, `notes`, `completed_by`, `parts[]`, `failures[]` (`FailureEvent`, oldest first), `version` (ETag; `If-Match` on `PUT`/`PATCH`), `created_at`, `updated_at`. Lists are newest first (`sort_order=asc` for oldest), filterable by `vehicle_id`, `status`, `open`, `maintenance_type`.
- **Events:** `MaintenanceRecordOpened`, `MaintenanceRecordUpdated` (with `changed_fields`) and `MaintenanceRecordCompleted`, each with `maintenance_record_id`, `vehicle_id` and `maintenance_flag_cleared`; `MaintenanceRecordCompleted` also carries `odometer_km` (or `null`) and `completed_at`, an odometer reading (FMS-126). `FailureRecorded` once per failure, on the vehicle's aggregate.

Inventory rules (FMS-23):

- **Who:** `inventory:read` / `inventory:write`: admin, fleet manager, depot admin, technician. A driver (or dispatcher) gets `403` on every inventory endpoint. A depot-scoped caller sees their depots' parts plus shared stock (`depot_id: null`); creating or changing shared stock needs a fleet-wide role (`403` otherwise).
- **`InventoryPart`:** `id`, `part_number` (trimmed, upper case, unique: `409 CONFLICT_DUPLICATE`), `name`, `description`, `depot_id`, `unit_cost_cents` (whole cents, else `VALIDATION_FLOAT_IN_MONEY_PATH`), `stock_quantity`, `reorder_threshold` (the "reorder level"), `below_reorder` (`stock_quantity <= reorder_threshold`), `stock_status` (`out` at 0, `low` at or below the threshold, `ok`), `service_item`, `is_active`, `version`, `created_at`, `updated_at`.
- **What a part renews (FMS-52):** `service_item` on create and update is one of `engine_oil, air_filter, fuel_filter, coolant, brake_pads, brake_fluid, clutch_fluid, tyres, battery, gearbox_oil, belts`, or `null` for a part that renews none (`400` for anything else). A completed repair that used the part is a change of that item. `GET /vehicles/{vehicle_id}/service-items` (vehicles in the caller's depots; `404` otherwise) lists every item with `last_changed_at`, `maintenance_record_id`, `odometer_km` and `part_number` from the latest such repair, or `null`s when it was never changed in the system. The predictive model's part history reads this ([ml-dataset.md](ml-dataset.md)).
- **List:** `below_reorder=true` (or `belowReorder=true`) returns only parts at or below their threshold; `stock_status=out|low|ok` returns one status band (`out`: 0; `low`: 1 to the threshold; `ok`: above it), as on the inventory screen (FMS-25). Also `depot_id`, `search` (part number, name), `status` (`active` default, `inactive`, `all`), `sort_by` (`part_number`, `name`, `stock_quantity`), `sort_order`.
- **Stock changes** only through the ledger: opening stock on create (`purchase`), `POST /inventory/{id}/adjust` (`adjustment`) and repairs (`consumption`, FMS-22). Stock is `CHECK (stock_quantity >= 0)`.
- **Adjust:** `{ quantity, reason }`: a non-zero whole number (positive in, negative out) and a reason (3-500 characters). One that would make stock negative is `409 CONFLICT_INSUFFICIENT_STOCK` and changes nothing. Each adjustment writes an audit row with the old and new `stock_quantity`, and a ledger line with the reason. `PUT` cannot set stock (`not_writable`).
- **Events:** `InventoryPartCreated`, `InventoryPartUpdated` (`changed_fields`), `InventoryStockAdjusted` (`quantity_delta`, `stock_quantity`, `reason`), and `InventoryReorderNeeded` when stock falls to or below the threshold from above it, by an adjustment or a repair.

### 10.2 Predictive maintenance

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /maintenance-predictions` | Persisted ML predictions | `prediction:read` | Paged `Prediction[]` |
| `GET /vehicles/{vehicle_id}/maintenance-risk` | Current maintenance risk | `prediction:read` | `MaintenanceRisk` |
| `POST /maintenance-predictions/{prediction_id}/feedback` | What an inspection of the flagged vehicle found (FMS-128) | `prediction:read` + `maintenance:write` | `{outcome, component?, failure_event_id?, comment?}` -> `201 PredictionFeedback`; `409` when it already has feedback |
| `PATCH /maintenance-predictions/{prediction_id}/feedback` | The author changes it, for 7 days | `prediction:read` + `maintenance:write` | the fields to change -> `PredictionFeedback`; `403 not_author`, `409 edit_window_closed` |
| `GET /ml-models` | The model registry (FMS-127) | `prediction:read` | `status?`, paging -> `MlModel[]`, newest first; each with `feedback` (FMS-128) |
| `GET /ml-models/{model_id}` | One registered model | `prediction:read` | `MlModel` |
| `POST /ml-models/{model_id}/activate` | Let a registered model score | `ml-model:activate` (admin) | -> `MlModel`; `409` when trained on other inputs |

**The model registry (FMS-127).** Every prediction can be traced to the model, data and metrics behind it. How it works: [docs/ml-model-registry.md](ml-model-registry.md).

- **`MlModel`:**
  - `id`, `name`, `version`, `status` (`registered`, `active`, `retired`);
  - `algorithm`, `features` (in order), `feature_spec_version`, `feature_spec_hash`, `features_match`;
  - `metrics` (`roc_auc`, `brier`, `at_alert_threshold.precision`, `.recall`, `.f1`, ...), `training_data` (file and its SHA-256, rows, vehicles, dates, split);
  - `trained_at`, `artefact_sha256`, `first_seen_at`, `activated_at`, `activated_by`, `retired_at`.
- **Registration** is the scoring job's alone, the first time the ML service serves a version (`GET /model`, §10.3). There is no endpoint to register or change a model.
- **Scoring needs** the served model to be active and trained on the core's feature spec: its `feature_spec_hash` is the SHA-256 of `feature_spec.json`'s inputs and label, hashed the same way in Python and Node. Otherwise nothing is scored, and administrators get an `ml_scoring_blocked` alert (`MlScoringBlocked`).
- **Activation** is explicit: a new version scores only once an administrator activates it, here or with `npm run ml:model -- activate <version> --by <email>`. It retires the model that was active (one active model per name). Activating a retired model again is a rollback. A model with `features_match: false` is `409 CONFLICT_INVALID_STATE_TRANSITION`, reason `feature_spec_mismatch`.
- **Predictions** name a registered model: `maintenance_predictions (model_name, model_version)` references the registry.

**The nightly scoring (FMS-55).** The job `maintenance-scoring` (02:00) scores every vehicle in service. Only the batch writes scores: no endpoint calls the model. How it works: [docs/ml-scoring.md](ml-scoring.md).

- **Inputs:** the 19 of `feature_spec.json`, computed by the core from its own tables as of the start of the day (Addis Ababa), capped and rounded to the spec.
- **Calls:** batches of 100 to `POST /internal/ml/predict-maintenance/batch` (§10.3), through the integration gateway: 10 s per attempt, 2 retries, the ML service's circuit breaker.
- **Stored:** a `maintenance_predictions` row per vehicle and night (`health_score`, `risk_level`, `factors`, `risk_score`, `feature_snapshot`, `as_of`; the previous one is `superseded`), and the vehicle's `health_score` and `health_score_updated_at`.
- **Risk:** a score falling below 75, or its risk level rising, publishes `MaintenanceRiskDetected`: a `maintenance_risk` alert for the vehicle's technicians and depot admins.
- **Failures:** an ML service that is down, a failing batch, an open breaker, or a model that may not score skips those vehicles, which keep their last score. The run still finishes.

**Maintenance risk (FMS-56).** `GET /vehicles/{vehicle_id}/maintenance-risk` (`prediction:read`: not dispatchers or drivers; depot scope, `404` outside it or for an id that is not a UUID) is the vehicle's latest stored prediction, never a new model call. How the screen uses it: [docs/vehicle-health.md](vehicle-health.md).

- **`MaintenanceRisk`:** `vehicle_id`, `prediction_id`, `health_score`, `risk_level` (`low`, `medium`, `high`), `failure_probability`, `prediction_horizon_days` (30), `factors`, `model_name`, `model_version`, `as_of` (the time the inputs were computed as of), `scored_at`, `stale` (scored more than 25 hours ago), `feedback` (what a technician found for this prediction, or `null`).
- **Feedback on a prediction (FMS-128).** `POST /maintenance-predictions/{prediction_id}/feedback` (`prediction_id` is the one `MaintenanceRisk` returns) records the outcome of inspecting a flagged vehicle: `confirmed_issue`, `no_issue_found`, `already_fixed` or `not_inspected`. A confirmed issue may carry the `component` found and the `failure_event_id` it led to (§8.4: the same vehicle's, in scope; the component defaults to the failure's and may not contradict it); the other outcomes carry neither (`400`, `only_for_confirmed_issue`). Needs `prediction:read` and `maintenance:write`; a prediction on a vehicle outside the caller's depots, or one that was never scored, is `404`; a superseded prediction can still be given feedback. One feedback per prediction (`409 CONFLICT_DUPLICATE`, `already_recorded`, naming it). Its author can change it with `PATCH` for 7 days (`403 not_author`, `409 edit_window_closed`); changing the outcome away from a confirmed issue drops the component and the failure link, and a change that changes nothing writes nothing. It is never deleted. `PredictionFeedbackRecorded` is published on each write (`edited` says which), on the vehicle's aggregate. `PredictionFeedback`: `id`, `prediction_id`, `outcome`, `component`, `failure_event_id`, `comment`, `recorded_by`, `created_at`, `updated_at`, `editable_until`, `can_edit` (the caller is the author and the time has not passed).
- **The confirmed share, per model version.** Each `MlModel` of `GET /ml-models` carries `feedback`: the version's `high_risk_predictions`, how many have feedback, the count of each outcome, `reviewed` (`confirmed_issue` + `no_issue_found` + `already_fixed`; `not_inspected` judges nothing, and an issue already fixed cannot be confirmed by an inspection, so it counts against), `precision` (`confirmed_issue / reviewed`, three decimals, `null` until something is reviewed) and `by_month` (the last 12 months feedback was given in, Addis Ababa, newest first). Only predictions at risk level `high` are counted.
- **`factors`:** up to 3 `{ feature, value, unit }`, the inputs raising the vehicle's risk most, largest first, with its value when scored and the spec's unit (`km`, `h`, `d`, `count`, `%`, `years`). Empty for a healthy vehicle.
- **Never scored:** every score field is null, `factors` is empty and `stale` is false.

### 10.3 Internal ML service contract

The predictive maintenance service (FMS-54, [ml-service.md](ml-service.md)) is reachable only inside the Docker network (`http://ai-service:5000`). Every call but `GET /health` sends `X-Internal-Token: <ML_SERVICE_TOKEN>`; without it, or with a wrong one, `401 AUTH_TOKEN_INVALID`.

| Method + path | Purpose | Request / response |
|---|---|---|
| `GET /health` | Liveness, no token | `{ status: "ok", model_version, load_seconds }` |
| `GET /model` | The model serving now (for the registry, FMS-127) | `name`, `model_version`, `trained_at`, `algorithm`, `features`, `feature_spec_version`, `feature_spec_hash`, `artefact_sha256`, `training_data`, `metrics`, `health_score`, `risk_levels`, `prediction_horizon_days` |
| `POST /internal/ml/predict-maintenance` | One vehicle | `PredictRequest` -> `Prediction` |
| `POST /internal/ml/predict-maintenance/batch` | 1 to 500 vehicles (the nightly scoring) | `{ items: PredictRequest[] }` -> `Prediction[]`, in the same order |

```http
POST /internal/ml/predict-maintenance
X-Internal-Token: <ML_SERVICE_TOKEN>

{
  "vehicle_id": "6f0f2b4e-6a1c-4c3e-9a55-3c2d4f9b8e11",
  "as_of": "2026-10-25T01:00:00+03:00",
  "features": {
    "mileage_km": 5214.0, "engine_hours": 131.2, "days_since_last_service": 100, "num_fault_reports": 5,
    "fuel_variance_pct": 2.1, "age_years": 7.9, "days_since_oil_change": 100, "km_since_oil_change": 17380.0,
    "...": "every input of feature_spec.json"
  }
}
```

```json
200
{
  "data": {
    "vehicle_id": "6f0f2b4e-6a1c-4c3e-9a55-3c2d4f9b8e11",
    "as_of": "2026-10-25T01:00:00+03:00",
    "failure_probability": 0.8125,
    "health_score": 19,
    "risk_level": "high",
    "prediction_horizon_days": 30,
    "model_version": "pm-2026.10",
    "factors": ["num_fault_reports", "days_since_last_service", "days_since_oil_change"]
  },
  "meta": { "request_id": "uuid", "model_version": "pm-2026.10" }
}
```

- **`PredictRequest`:** `vehicle_id` (UUID), `as_of` (an instant with offset) and `features`: every input of `packages/ai-service/feature_spec.json` (the 19 of spec version 2), each within its range, integers where the spec says `int`, and nothing else.
- **`Prediction`:** `failure_probability` (an unplanned failure in the next 30 days), `health_score` (`round((1 - p) * 100)`), `risk_level` (`low` at 75 and above, `medium` 41 to 74, `high` at 40 and below: the core raises a risk event below 75), `prediction_horizon_days` (30), `model_version`, and `factors`: up to 3 inputs that raise this vehicle's risk most (each, put back to the training rows' typical value, lowers the probability by at least 0.01), largest first. The model predicts no failure category (FMS-53).
- **Errors:** the core's envelope (§3.4). A missing, out-of-range, mistyped or unknown input, a missing `vehicle_id` or `as_of`, or a batch of 0 or more than 500 is `422 VALIDATION_FAILED`, each problem named: `{ field: "features.mileage_km", reason: "required" }`; in a batch, `items.3.features.age_years`. Reasons: `required`, `out_of_range`, `not_allowed`, `too_few`, `too_many`, `invalid_json`, `invalid`.
- **Correlation:** `X-Request-Id` is echoed (one is made when none is sent) and returned as `meta.request_id`.

The ML service never directly updates fleet master data. The Node.js core validates the result and persists `maintenance.maintenance_predictions`. This preserves the selected modular-monolith boundary with one specialized service.

## 11. Tracking and Command Center API

### 11.1 Tracking

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /tracking/vehicles/current` | Current fleet locations (the live map, FMS-45) | `tracking:read` | `depot_id?` -> `VehicleLocation[]`; cached 5 s |
| `POST /tracking/gps-pings` | Telemetry ingestion | Device token, `tracking:ingest`, or `trip:execute` (a driver's phone) | `{pings: GPSPoint[]}` (1-500) -> `202 {accepted, duplicates, rejected[]}`; high-volume endpoint |
| `GET /vehicles/{vehicle_id}/tracking` | Historical GPS (FMS-136) | `tracking:read` | `from`, `to` (both included), `limit` (1-1000, default 500), `cursor` -> `TrackPoint[]` oldest first, `meta.next_cursor` for the next page or `null`; depot scope, another depot's vehicle is `404` |
| `GET /vehicles/{vehicle_id}/telemetry-flags` | Telemetry warnings (FMS-46) | `tracking:read` | `flag_type,from,to,ongoing,limit` -> `TelemetryFlag[]`, newest first |
| `GET /command-center/overview` | Operational overview | `command:read` | Vehicle state, alerts, incidents, trip summary |

**Live map snapshot (FMS-45).** `GET /tracking/vehicles/current` lists the caller's vehicles (depot scope; `depot_id` narrows it, and a depot outside the scope gives `[]`) that are not retired and have a position or a trip under way, by plate. How the command center uses it: [docs/live-map.md](live-map.md).

- **`VehicleLocation`** (out):
  - the vehicle: `vehicle_id`, `registration_number`, `vehicle_type`, `vehicle_status`, `maintenance_flag`, `depot_id`;
  - `position`: `{lat, lng, speed_kmh, heading, accuracy_m, ignition_on, recorded_at, stopped_since}`, or `null` for a vehicle on a trip that has not reported yet. `stopped_since` is set while at 0 km/h: the first stopped ping after it last moved, within 2 hours;
  - `trip`: `{trip_id, route_name, origin, destination, started_at, scheduled_end, driver: {driver_id, full_name}}` for the trip under way, or `null`;
  - `flags`: open, unresolved telemetry flags, the newest of each type: `{flag_type, severity, observed_at}`.
- **Freshness.** Cached in Redis for 5 s, one snapshot per depot shown (`integration:live-map:<depot public id>`, or `all`), shared by everyone who sees it. Trip and vehicle events drop it after commit. Positions move on through `vehicle.location.updated` meanwhile.

**GPS ingestion (FMS-88).** How it works, the webhook format and the simulator: [docs/gps-ingestion.md](gps-ingestion.md).

- **`GPSPoint`** (in): `recorded_at` (ISO with offset), `lat`, `lng`, `speed_kmh` (0-300, rounded to whole km/h), and optionally `heading`, `accuracy_m`, `altitude_m`, `ignition_on`, `odometer_km`. A user with `tracking:ingest` adds `vehicle_id`; for a device or a phone it is implied.
- **Who may report what.**
  - A device (`Authorization: Bearer fmsd_...`) reports for its own vehicle only.
  - A driver's phone (`trip:execute`) reports for the vehicle of a trip the driver drove, each ping in the trip it was recorded in (`actual_start <= recorded_at <= actual_end`, or still under way), however late the phone delivers it (FMS-124).
  - Naming another vehicle, or having no trip started in the last 7 days, refuses the whole batch: `403 FORBIDDEN_INSUFFICIENT_ROLE`, reason `not_your_vehicle` or `no_trip_under_way`. A ping in no trip of the driver is refused alone: `no_trip_at_time`.
  - `gps_pings.trip_id` is the trip at `recorded_at` for every source. A ping of a trip that has ended is stored but never becomes the vehicle's current position or an event.
  - An unknown device token is `401 AUTH_TOKEN_INVALID`.
- **Validation.** Out of range or unknown fields: `400`, the whole batch, naming `pings.<i>.<field>`. A readable ping that cannot be used is refused alone in `rejected[]`: `future_timestamp` (over 2 min ahead), `too_old` (over 7 days), `low_accuracy` (over 500 m), `vehicle_retired`, `unknown_vehicle`, `no_trip_at_time` (a phone, at a time with no trip of its driver).
- **Duplicates.** A ping of a vehicle at an instant already stored is skipped (`(vehicle_id, recorded_at)`, §15), so a retried batch counts as `duplicates` and stores nothing.
- **Event.** `VehicleLocationUpdated` announces each vehicle's newest position at most once per `TRACKING_EVENT_INTERVAL_SECONDS` (5) of its pings; it reaches clients as `vehicle.location.updated` (§11.2).

**Telemetry rules (FMS-46).** Speeding (over 80 km/h for 3 pings in a row; 3 at or under it clear it) and idling (5 minutes at 0 km/h, engine not reported off) open and close `tracking.telemetry_flags`, one ongoing flag per vehicle and type. Thresholds are per depot in `tracking.rule_thresholds`. How it works: [docs/telemetry-rules.md](telemetry-rules.md).

- **`TelemetryFlag`** (out): `flag_id`, `vehicle_id`, `trip_id`, `flag_type`, `severity` (`high` speeding, `medium` idling), `status` (the review status), `observed_at` (the condition began), `resolved_at` (it ended; null while it lasts), `details` (`speed_limit_kmh`, `speed_kmh`, `consecutive_pings`, `idle_minutes`, `lat`, `lng`, `flagged_at`; on closing `end_reason`, `duration_seconds`, `max_speed_kmh`).
- **`GET /vehicles/{vehicle_id}/telemetry-flags`:** `flag_type` (comma-separated), `from`/`to` (ISO with offset, on `observed_at`), `ongoing` (`true`/`false`), `limit` (1-200, default 50). Behavioural data (§24.3): `tracking:read` only, never drivers; a vehicle outside the caller's depot scope is `404`. Names the trip, not the driver.
- **Events.** `TelemetryFlagRaised` (an `unsafe_driving` alert, docs/alerts.md) and `TelemetryFlagResolved`; both reach clients as `vehicle.flag.changed` (§11.2).

The previous contract defined a client-to-server Socket.IO `location_update` event. In the canonical contract, high-volume telemetry ingestion is REST/webhook based and Socket.IO is used for server-to-client fan-out. This is a deliberate replacement, not a loss of the capability.

### 11.2 Real-time Socket.IO event contract

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `vehicle.location.updated` | Server -> client | `vehicle_id,lat,lng,speed,heading,recorded_at` | Move live marker |
| `vehicle.status.changed` | Server -> client | `vehicle_id,status,reason` | Operational state update |
| `alert.created` | Server -> client | `Alert` | New alert |
| `alert.updated` | Server -> client | Alert patch | Acknowledge/resolve update |
| `incident.created` | Server -> client | `Incident` | New active incident |
| `notifications.unread` | Server -> client | `unread_count,reason,changed_at` | The user's unread in-app count changed (`reason`: `delivered`, `read`, `read_all`). Sent to that user's own sockets only |
| `trip.updated` | Server -> client | Trip summary | Refresh trip board |
| `vehicle.flag.changed` | Server -> client | `flag_id,vehicle_id,trip_id,flag_type,severity,observed_at,resolved_at,change` | A speeding or idling flag opened (`raised`) or closed (`resolved`); the live map re-reads (FMS-46) |
| `location_update` | Client -> server (legacy compatibility only) | `tripId,lat,lng,speedKmh,bearing,accuracyM` | Accepted only if a legacy/mobile client still uses Socket.IO ingestion (`REALTIME_LEGACY_LOCATION`); canonical ingestion is REST/webhook. Goes through GPS ingestion as a phone: `tripId` must be the sender's trip under way |
| `vehicle_position` | Server -> client (legacy event name) | `vehicleId,tripId,lat,lng,speedKmh,bearing,lastSeen` | Compatibility alias for `vehicle.location.updated` |
| `alert_created` | Server -> client (legacy event name) | `alertType,entityId,message,severity` | Compatibility alias for `alert.created` |

Real-time rules (FMS-43; details in docs/realtime.md):

- **Connection:** Socket.IO at `/api/v1/socket.io` on the API's server. The handshake carries the session cookie and is checked like any API call (`connect_error` message `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_REVOKED` or `AUTH_ACCOUNT_DISABLED`). A browser `Origin` must be the API's own or listed in `REALTIME_ALLOWED_ORIGINS`. The server closes the socket when the access token expires and when the account is deactivated or its roles or account change; the client renews the session and reconnects.
- **Who receives what:** the same permission and scope as the REST data. `vehicle.location.updated` and `vehicle.flag.changed` need `tracking:read`, `vehicle.status.changed` `vehicle:read`, `alert.*` `alert:read`, `trip.updated` `trip:read`, `incident.created` `incident:read`. Staff receive their depot's events (depot-unscoped roles: every depot). A driver receives their own trips' `trip.updated` and their depot's `vehicle.status.changed`.
- **Notifications:** `notifications.unread` is not a channel anyone subscribes to: it goes to the room of the one user it is about, which only that user's own sockets join, so no permission or role (an admin's included) receives another user's count.
- **Payloads** carry public ids, never personal data. `trip.updated` is the trip summary: `trip_id, status, route_name, depot_id, vehicle_id, driver_id, scheduled_start, scheduled_end, actual_start, actual_end, version, updated_at` and `change` (the domain event). `vehicle.status.changed` also carries `previous_status, source, changed_at`. `alert.updated` follows acknowledge and resolve. Events are hints: a client reloads its data over the API after reconnecting, and late events are dropped (positions after 30 s, others after 5 minutes).
- **Client -> server:** only the legacy `location_update`, off unless `REALTIME_LEGACY_LOCATION=true`, acknowledged `{ok}` or `{ok: false, error: {code, message}}`. Every client event is rate limited (5 at once, then 1 per second; `RATE_LIMITED`); a socket that keeps exceeding it is closed.

## 12. Alerts, Notifications and Incidents

An alert is a business event requiring attention. A notification is a delivery attempt for an alert through email, SMS, push or another channel. Incidents represent operational or safety events requiring investigation and lifecycle management.

### 12.1 Alerts and notifications

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /alerts` | Search alerts | `alert:read` | `status`, `severity`, `type` (comma-separated), `vehicle_id`, `depot_id`, `sort` (`newest`, `priority`), `page`, `page_size` -> Paged `Alert[]`; depot scope |
| `GET /alerts/{alert_id}` | Alert detail | `alert:read` | `Alert` |
| `POST /alerts/{alert_id}/acknowledge` | Acknowledge alert | `alert:ack` | `{comment?}` -> `Alert`; only an `open` alert (`409 CONFLICT_INVALID_STATE_TRANSITION` otherwise) |
| `POST /alerts/{alert_id}/resolve` | Resolve alert | `alert:resolve` | `{comment?}` -> `Alert`; an `open` or `acknowledged` alert |
| `GET /notifications` | The caller's in-app inbox | `notification:read` | `status` (`all` default, `unread`, `read`), `type` (comma-separated), `page`, `page_size` -> Paged `Notification[]`, newest first; `meta.unread_count` is the whole inbox's |
| `PATCH /notifications/{notification_id}/read` | Mark one read | `notification:read` | No body -> `Notification`; `meta.unread_count`; safe to repeat |
| `POST /notifications/read-all` | Mark all read | `notification:read` | No body -> `{updated}`; `meta.unread_count` is 0 |

**Alert engine (FMS-92).** Alerts are raised from domain events by rule, de-duplicated per source within a window, notified in-app to the roles of the alert's depot, and escalated when critical and unacknowledged (fleet managers after `ALERT_ESCALATION_MINUTES`, 15, then admins). Rules, recipients and escalation: [docs/alerts.md](alerts.md).

**Inbox rules (FMS-48).**

- **Own notifications only.** Every role holds `notification:read`; what a user gets is limited to the rows addressed to them, not by permission. Another user's notification by id (even for an admin) is `404 NOT_FOUND`, the same body as a missing id, and it is not changed. Only the in-app channel is the inbox: email, SMS and push deliveries of the same user never appear.
- **The last 30 days.** The inbox is the notifications of the last 30 days (FMS-49: the panel shows nothing older). The window applies to the list, `meta.unread_count` and `read-all` alike, so a badge never counts what the list does not show. Older rows stay in the table and are not anyone's inbox.
- **`Notification`:** `id`, `type` (`alert`, `alert_escalated`), `title`, `message`, `alert_id` (the alert it is about, or null), `entity` (`{type, id}`: what that alert is about, e.g. `dvir_report`, `document`, `driver`, `fuel_anomaly`, or null), `vehicle_id` and `driver_id` (the ones the alert concerns, or null), `read`, `read_at`, `created_at`. A screen builds its link from `entity`, `vehicle_id` and `driver_id` (the web app: [docs/alerts.md](alerts.md#the-bell-fms-49)). A notification is never edited or deleted here.
- **Marking read:** `PATCH .../read` on one already read answers `200` with it unchanged and writes nothing. `POST /notifications/read-all` marks the caller's unread ones and says how many (`updated`); with none it changes nothing. A body, or any parameter these endpoints do not take, is `400` (`reason: "not_writable"`). A malformed id is `404`.
- **Unread count.** Every list carries `meta.unread_count`, and every change to it is announced: `NotificationUnreadChanged` is published in the transaction that delivers notifications (the alert engine) or marks them read, and reaches the user's open screens as `notifications.unread` (§11.2) well within a second.
- **Audit.** Marking one read is one audit row; read-all is one audit entry for the batch (`notification.read_all`, with the count).

### 12.2 Incidents

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /incidents` | Create incident | `incident:write` | `description`, `severity`; optional `vehicle_id`, `trip_id`, `driver_id` (staff), `latitude` with `longitude`, `incident_type` (default `other`), `occurred_at` (default now) -> `201 Incident`; Idempotency-Key; a late replay of the same report -> `200` with `meta.created: false` |
| `GET /incidents` | List incidents | `incident:read` | `status`, `severity`, `incident_type` (comma-separated), `vehicle_id`, `from`, `to`, `page`, `page_size` -> Paged `Incident[]`, newest first; a driver sees only what they reported, staff their depots' |
| `GET /incidents/{incident_id}` | Incident detail | `incident:read` | `Incident` |
| `PATCH /incidents/{incident_id}` | Update incident | `incident:write` | `IncidentUpdate` -> `Incident` |

Incident and alert `severity` is one of `low`, `medium`, `high`, `critical`. The reporter is the authenticated user.

**Incident reports (FMS-38).** An incident belongs to its vehicle's depot, or the reporter's. A critical one sets the vehicle's maintenance flag in its transaction and becomes an alert; every one publishes `IncidentReported` (`incident.created` on the socket). `PATCH` is not built yet. Fields, refusals and the offline replay: [docs/incidents.md](incidents.md).

## 13. EV Fleet Management API

### 13.1 EV and charging endpoints

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /ev/battery-logs` | Battery history | `ev:read` | Paged `EVBatteryLog[]` |
| `POST /ev/battery-logs` | Record battery observation | `ev:write` | `EVBatteryLogCreate` -> `EVBatteryLog` |
| `GET /ev/charging-stations` | Charging stations | `ev:read` | `ChargingStation[]` |
| `POST /ev/charging-sessions` | Create/start charging session | `ev:write` | `ChargingSessionCreate` -> `ChargingSession` |
| `PATCH /ev/charging-sessions/{id}` | Update charging session | `ev:write` | `ChargingSessionUpdate` -> `ChargingSession` |
| `GET /vehicles/{vehicle_id}/charging-sessions` | Vehicle charging history | `ev:read` | Paged `ChargingSession[]` |
| `GET /vehicles/{vehicle_id}/battery-summary` | Battery health summary | `ev:read` | `BatterySummary` |

## 14. Analytics API

### 14.1 Analytics endpoints

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /analytics/fleet-summary` | Fleet utilisation, cost and status (FMS-50) | `analytics:read` | `from`, `to`, `depot_id` -> `FleetSummary`: vehicles by status, flagged and average health score; utilisation, distance, completed trips, on-time, fuel, fuel and repair cost, cost per km; open alerts by severity; and the same KPIs per day (`daily`) |
| `GET /analytics/utilisation` | Utilisation by vehicle | `analytics:read` | `from`, `to`, `depot_id` -> `UtilisationSummary`: the fleet's `utilisation_pct`, `vehicle_days`, `days_used`, and each vehicle's, highest first |
| `GET /analytics/fuel-efficiency` | Fuel KPIs by vehicle | `analytics:read` | `from`, `to`, `depot_id` -> `FuelEfficiencySummary[]`: fuel (ml) and its cost, distance, `ml_per_km` against `rated_ml_per_km` (`variance_pct`), fuel cost per km; costliest first |
| `GET /analytics/maintenance-risk` | Maintenance risk by vehicle | `analytics:read` | `from`, `to`, `depot_id` -> `MaintenanceRiskSummary[]`: health score, maintenance flag, the highest active prediction (`risk_pct`, type, failure, when) and the range's repair cost; riskiest first |
| `GET /analytics/trips` | Trip KPIs | `analytics:read` | `from`, `to`, `depot_id` -> `TripAnalytics`: trips planned in the range by status, completed, on time (ended within 15 minutes of the scheduled end), distance, and per day |
| `GET /analytics/alerts` | Alert KPIs | `analytics:read` | `from`, `to`, `depot_id` -> `AlertAnalytics`: open alerts by severity now; raised in the range by severity, by type and per day; mean minutes to acknowledge |

- **Range:** `from` and `to` are Addis Ababa days, both included; the 30 days to today by default, never past today, at most 366 days (`400 VALIDATION_FAILED`, `before_from` or `range_too_long`).
- **Who:** the caller's depots (admins, fleet managers, owners and compliance officers see every depot); `depot_id` narrows to one of them, and a depot that is unknown or not the caller's gives zeros. A driver has no `analytics:read` (`403`).
- **Integers:** percentages are whole percent, fuel is ml, money is cents, cost per km is whole cents per km, all rounded half away from zero; a ratio with nothing to divide by is `null`.
- **Cache:** the KPIs are summed from `analytics.analytics_cache`, one row per vehicle and day, refreshed hourly (today and yesterday) and nightly (35 days back) ([analytics.md](analytics.md)). `meta` gives `from`, `to`, `days`, `computed_at` (the last refresh) and `stale: true` when that is more than 25 hours ago or the cache was never filled. Answers are kept in Redis for 5 minutes per caller scope and range, and dropped by each refresh.

Analytics and reporting reads go to the PostgreSQL read replica (FMS-94, [read-replica.md](read-replica.md)): today `GET /fuel-reconciliation`, `GET /vehicles/{vehicle_id}/fuel-summary`, `GET /audit-logs` and the analytics endpoints above. Their responses include the reporting period where they have one and `meta.data_freshness` (FMS-94, [read-replica.md](read-replica.md)): `source` (`replica` or `primary`), `lag_seconds` (how far the data may be behind the primary; 0 from the primary) and `as_of` (now less the lag), because replica lag is possible. A replica that is down or too far behind is not read: the primary answers, and says so.

## 15. Integrations and Webhooks

### 15.1 External integration endpoints

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /webhooks/telematics/{provider}` | Receive signed telemetry | Provider signature/secret | 202 Accepted |
| `POST /webhooks/fuel-card/{provider}` | Receive fuel-card data | Provider signature/secret | 202 Accepted |
| `POST /webhooks/ev/{provider}` | Receive charging event | Provider signature/secret | 202 Accepted |
| `GET /integrations/providers` | Provider status | `integration:read` | `Provider[]` |
| `POST /integrations/providers/{id}/sync` | Trigger provider sync | `integration:execute` | 202 + `SyncLog` |

Webhook handlers verify signatures, validate schema and version, create a correlation id, normalize provider payloads, and persist/enqueue work. They return quickly so provider retries do not create duplicate business work. Idempotency is required for retried external events.

### 15.2 Integration gateway (FMS-85)

How it works and how to add a provider: [docs/integrations.md](integrations.md).

- **Signature.** A webhook carries `X-FMS-Timestamp` (Unix seconds) and `X-FMS-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>` with the provider's shared secret (`INTEGRATION_<CODE>_WEBHOOK_SECRET`, never in the database). `{provider}` in the path is the provider's `code`.
- **Refusals.**
  - `404 NOT_FOUND`: no active provider of the path's type with that code, or one without a secret or an adapter. The same answer in each case.
  - `401 AUTH_TOKEN_INVALID`: the signature is missing, malformed or wrong (`details[].reason` `missing_signature`, `malformed_signature`, `signature_mismatch`).
  - `401 AUTH_TOKEN_EXPIRED`: a genuine signature whose timestamp is more than 5 minutes from the server clock. This is a replay, `reason` `stale_timestamp`.
  - `400 VALIDATION_FAILED`: a body the provider's adapter cannot read (recorded as a failed sync log).
  - `415 UNSUPPORTED_MEDIA_TYPE`: not JSON.

  Nothing is stored for a refused signature.
- **Acceptance.** `202 { data: { id, status: "accepted", duplicate }, meta }`, where `id` is the inbound sync log.
  - A redelivery of an event id already stored is `202` with `duplicate: true` and the first delivery's `id`; nothing is stored or announced again. The key is `(provider_id, external_reference)` on inbound `integration.sync_logs`.
  - The delivery is announced as `IntegrationWebhookReceived` for the module that processes it.
- **`Provider`** (`GET /integrations/providers`, `?check=true` runs health checks first):
  - `id`, `code`, `name`, `provider_type`, `is_active`;
  - `status` (`operational`, `degraded`, `down` while the circuit is open, `unknown`, `inactive`);
  - `capabilities` (`sync`, `webhooks`, `health_check`), `webhook_secret_configured`;
  - `last_success_at`, `last_failure_at`, `last_error`, `last_sync`;
  - `circuit` (this API instance's breaker: `state`, `opened_at`, `retry_at`, the 60 s window's counts, `latency_mean_ms`; null until the instance has called it);
  - `health`.

  `configuration` and secrets are never returned.
- **`SyncLog`:** `id`, `provider_id`, `direction` (`inbound`, `outbound`), `status` (`started`, `succeeded`, `failed`, `partial`), `trigger` (`manual`, `webhook`), `kind`, `records`, `external_reference`, `request_id`, `started_at`, `completed_at`, `error_message`. The error message is ours (a status, a timeout), never the provider's response.
- **Manual sync.** `POST /integrations/providers/{id}/sync` answers `202` with a `started` sync log and runs the sync after the response.
  - A sync already running is returned instead (`meta.already_running: true`).
  - `400 VALIDATION_FAILED` with `provider_inactive` or `sync_not_supported`.
  - `503 UPSTREAM_UNAVAILABLE` with `Retry-After` while the provider's circuit is open.
- **Calls to providers.** Every attempt has a timeout (5 s by default).
  - **Retries:** idempotent calls only, after a timeout, a network error, 408, 429 or 5xx; at most 2, with full-jitter exponential backoff.
  - **Breaker:** it opens once its 60 s window holds at least 5 calls and more than half failed (5 failures in a row always do), and calls then fail fast without reaching the provider. A trial call after 30 s closes or reopens it.
  - Settings per provider: `timeout_ms`, `max_retries` and `reset_timeout_ms` in `configuration`.

Retries are de-duplicated on these keys, with `INSERT ... ON CONFLICT DO NOTHING`:

| Event | De-duplication key |
|---|---|
| Telemetry | `(vehicle_id, recorded_at)` on `tracking.gps_pings` |
| Fuel card | `(provider_id, external_transaction_id)` on `integration.fuel_card_transactions` |
| EV charging | `external_session_id` on `ev.charging_sessions` |

## 16. Resource Schemas

### 16.1 Vehicle

```json
{
  "id": "uuid",
  "registration_number": "ABC123",
  "vin": "string",
  "make": "string",
  "model": "string",
  "year": 2024,
  "vehicle_type": "truck",
  "fuel_type": "diesel",
  "fuel_efficiency_ml_per_km": 320,
  "status": "active",
  "maintenance_flag": false,
  "health_score": 87,
  "health_score_updated_at": "2026-10-26T02:00:04Z",
  "depot_id": "uuid",
  "odometer_km": 128450.5,
  "current_trip": {
    "id": "uuid",
    "status": "en_route",
    "origin": "Addis Ababa",
    "destination": "Adama",
    "scheduled_start": "2026-10-05T07:30:00Z"
  },
  "version": 3,
  "created_at": "2026-10-05T07:00:00Z",
  "updated_at": "2026-10-05T07:00:00Z"
}
```

### 16.2 Trip

```json
{
  "id": "uuid",
  "vehicle_id": "uuid",
  "driver_id": "uuid",
  "route_id": "uuid",
  "status": "en_route",
  "scheduled_start": "2026-10-05T08:00:00Z",
  "scheduled_end": "2026-10-05T10:30:00Z",
  "actual_start": "2026-10-05T08:03:12Z",
  "actual_end": null,
  "version": 3,
  "stops": []
}
```

`status` is one of `draft`, `scheduled`, `assigned`, `en_route`, `completed`, `cancelled`. `vehicle_id` and `driver_id` are `null` until the trip is assigned. Send `version` back on `PATCH`; a stale value returns `409 CONFLICT_CONCURRENT_MODIFICATION`.

### 16.3 Alert

```json
{
  "id": "uuid",
  "vehicle_id": "uuid",
  "type": "fuel_anomaly",
  "severity": "high",
  "status": "open",
  "title": "Unexpected fuel consumption",
  "message": "Fuel consumption exceeded expected range.",
  "created_at": "2026-10-05T07:15:00Z",
  "acknowledged_at": null,
  "resolved_at": null
}
```

Since FMS-92 an alert also carries `priority` (1 critical to 4 low), `depot_id`, `driver_id`, `trip_id`, `entity_type` and `entity_id` (what it is about, by public id), `source` (`module`, `event_type`), `occurrence_count`, `last_occurred_at`, `escalation_level`, `escalated_at`, `acknowledged_by` and `resolved_by` (users' public ids). `message` is the alert's description.

## 17. Validation and Business Rules

| Rule | Requirement |
|---|---|
| Registration number | Unique and normalized |
| VIN | Unique when provided; format validation |
| Vehicle retirement | Soft retirement; do not destroy historical references; `409 CONFLICT_VEHICLE_IN_USE` while assigned |
| Driver retirement | Preserve historical trips and attendance |
| Attendance | Duplicate driver/date submissions -> `409 CONFLICT_ATTENDANCE_DUPLICATE` |
| Trip assignment | Driver overlap -> `409 CONFLICT_DRIVER_OVERLAP` |
| Vehicle assignment | Overlapping vehicle -> `409 CONFLICT_VEHICLE_OVERLAP`; forbidden maintenance state -> `409 CONFLICT_VEHICLE_FLAGGED` |
| Trip state | Only legal state transitions accepted |
| Maintenance | Starting active maintenance sets maintenance flag; completion clears it when applicable |
| Inventory | Inventory movement must never result in negative stock |
| Fuel quantity | Positive and within configured operational bounds |
| Fuel / money values | Money as integer minor units; reject floating-point money representations with `400 VALIDATION_FLOAT_IN_MONEY_PATH` |
| GPS speed | Stored as integer km/h; ingestion rounds fractional provider values to the nearest integer before insert |
| Odometer | Non-negative; downward jumps require correction workflow |
| Coordinates | Latitude -90..90; longitude -180..180 |
| EV charging | Explicit charging state machine; valid session transitions only |
| Writable fields | Only documented writable fields accepted |

## 18. Pagination, Filtering and Sorting

```http
GET /api/v1/vehicles?page=1&page_size=25&status=active&depot_id={uuid}&sort_by=registration_number&sort_order=asc
```

```json
{
  "data": [ ... ],
  "meta": { "page": 1, "page_size": 25, "total_items": 148, "total_pages": 6, "request_id": "uuid" }
}
```

Normal resources use `page`/`page_size`. Server page size is capped. Telemetry history uses cursor pagination and enforces maximum time range and record count to protect high-volume queries.

## 19. Idempotency and Concurrency

Retry-prone create and command endpoints support `Idempotency-Key`. The server stores the key, authenticated caller, request hash and outcome for a bounded retention period (`api.idempotency_keys`). Reusing the same key with a different body returns `409 CONFLICT_IDEMPOTENCY_KEY_REUSED`; reusing it while the first request is still running returns `409 CONFLICT_IDEMPOTENCY_IN_PROGRESS`. A retry with the same body gets the stored response again, with `Idempotent-Replayed: true`. Only a 2xx outcome is kept; any other response frees the key. Keys are per user and expire after 24 hours, except on the endpoints the driver's offline queue sends to (`POST /fuel-logs`, `/dvir-reports` and its `/dvir` alias, `/incidents`), which keep them 7 days, as long as the queue may hold a submission (FMS-116); the daily `idempotency-key-purge` job (02:00) deletes expired rows. The web client sends a UUID key with `api.request(path, { idempotencyKey: true })`, kept across its own token-refresh retry. State-changing operations use database transactions where multiple records must change atomically. Optimistic concurrency using `version`, `updated_at` or ETag should be used where stale writes are possible.

`Idempotency-Key` is optional on the endpoints marked with it. The first request with a key runs; a `2xx` response is stored and replayed to any retry with the same key and body, with the header `Idempotent-Replayed: true`. An error response frees the key, so a corrected retry may reuse it. Keys are per user and kept 24 hours; on `POST /fuel-logs`, `/dvir-reports` (and `/dvir`) and `/incidents`, 7 days (a driver's phone may hold a queued submission that long, and a fill-up has no natural duplicate check).

## 20. Rate Limiting and Resilience

| Client type | Suggested policy | Reason |
|---|---|---|
| Auth/public | Strict per-IP + account limit | Protect credentials and abuse surface |
| Authenticated UI | Per-user/token limit | Protect core API |
| Driver PWA | Burst allowance + sync throttling | Support intermittent connectivity |
| Webhooks | Per-provider limit | Protect from provider spikes |
| ML service | Service quota + timeout | Protect inference capacity |

- Bound request body sizes and use timeouts for external calls.
- Retry only safe operations automatically; use exponential backoff and jitter.
- Use circuit breaking for unstable external dependencies.
- Propagate request/correlation ids across API, ML and integrations.

## 21. Security Contract

- All production API traffic uses HTTPS/TLS; Socket.IO uses WSS.
- Authorization is enforced at API/service boundaries, not only in React.
- Browser access tokens are stored in Secure, HttpOnly cookies and protected with an appropriate SameSite policy; CSRF defenses are required for cookie-authenticated state-changing requests.
- Webhook signatures and service-to-service credentials are validated before processing.
- Passwords, access tokens, provider secrets and API keys are never logged.
- Sensitive actions generate audit events.
- API responses expose only documented fields; internal database columns are not leaked.

## 22. API-to-Database Mapping

| API area | Primary PostgreSQL schema(s) | Important tables / views |
|---|---|---|
| Authentication | `auth`, `shared` | users, roles, permissions, refresh_sessions |
| Fleet | `fleet` | vehicles, drivers, driver_vehicle_assignments, driver_attendance, dvir_reports, depots |
| Trips | `trip` | routes, trips, trip_stops |
| Fuel | `fuel` | fuel_logs, fuel_anomalies |
| Maintenance | `maintenance` | maintenance_records, maintenance_parts, inventory_parts, inventory_movements, maintenance_predictions |
| Tracking | `tracking` | vehicle_current_location, gps_pings, telemetry_flags |
| Alerts / incidents | `alert` | alerts, alert_acknowledgements, notifications, incident_reports |
| EV | `ev` | ev_battery_logs, charging_stations, charging_sessions |
| Integrations | `integration` | external_providers, gps_devices, sync_logs, fuel_card_transactions |
| Documents | `document` | documents (metadata only; files live in object storage) |
| Idempotency | `api` | idempotency_keys |
| Audit | `audit` | audit_logs |
| Analytics | `analytics` | reporting views, analytics_cache |

Every table the API exposes has a `public_id UUID`; that is the `id` in API payloads and paths.

## 23. End-to-End API Flows

### 23.1 Driver submits DVIR

```
React PWA
  -> POST /api/v1/dvir-reports
  -> Auth / RBAC
  -> Vehicle + trip validation
  -> PostgreSQL transaction
  -> Audit event
  -> 201 DVIRReport
  -> optional critical-defect alert
```

### 23.2 GPS update reaches Command Center

```
GPS provider
  -> POST /api/v1/webhooks/telematics/{provider}
  -> signature validation
  -> normalize telemetry
  -> PostgreSQL tracking.gps_pings
  -> update tracking.vehicle_current_location
  -> Redis pub/sub
  -> Socket.IO vehicle.location.updated
  -> React Command Center
```

### 23.3 Predictive maintenance

```
Node.js Core API
  -> POST /internal/ml/predict-maintenance/batch (X-Internal-Token)
  -> FastAPI validation (feature_spec.json) + model inference
  -> prediction result
  -> persist maintenance_predictions
  -> optional alert
  -> UI / Command Center update
```

### 23.4 Fuel anomaly and reconciliation

```
Driver / fuel card / provider
  -> POST /fuel-logs or webhook
  -> persist raw fuel observation
  -> calculate expected consumption
  -> compare actual vs expected
  -> persist fuel_anomalies
  -> GET /fuel-reconciliation for analytics
  -> alert if configured threshold is exceeded
```

## 24. Contract Governance and Compatibility

| Rule | Requirement |
|---|---|
| Versioning | Breaking changes require `/api/v2` or another explicitly documented breaking-version strategy |
| Compatibility | Prefer additive optional fields over changing/removing existing fields |
| Canonical source | OpenAPI specification is the machine-readable source of truth; this document provides the architectural interpretation and business rules |
| Testing | Contract tests cover request/response schemas, auth, errors, idempotency and key business conflicts |
| Deprecation | Deprecated endpoints/fields include a removal target and migration path |
| Ownership | Each bounded module owns its routes, schemas, validation and service contract |
| Legacy path mapping | Where the old contract used shorter paths, the canonical path is documented and the old path is retained as a compatibility alias only when needed |

## 25. Legacy-to-Canonical Mapping

| Old contract capability | Canonical endpoint | Compatibility decision |
|---|---|---|
| `GET /audit` | `/audit-logs` | Retained as compatibility alias |
| `GET/POST /depots` | `/depots` | Retained |
| `GET/POST/PUT /attendance` | `/attendance` + `/attendance/{id}` | Retained and expanded |
| `POST /documents`, `GET /documents/{id}` | `/documents` + `/documents/{id}` | Retained |
| `POST /trips/{id}/assign` | `/trips/{trip_id}/assign` | Retained as canonical command |
| `POST /dvir` | `/dvir-reports` | Retained as compatibility alias |
| `POST /incidents` | `/incidents` | Retained |
| `POST /inventory/{id}/adjust` | `/inventory/{part_id}/adjust` | Retained as a command that creates an inventory movement |
| `POST /fuel-logs` | `/fuel-logs` | Retained |
| `GET /fuel-reconciliation` | `/fuel-reconciliation` | Retained |
| `GET /analytics/utilisation` | `/analytics/utilisation` | Retained as a compatibility view of utilization metrics |
| Socket `location_update` | `POST /tracking/gps-pings` or signed telematics webhook | REST/webhook is canonical high-volume ingestion; Socket.IO event retained only for legacy mobile clients |
| Socket `vehicle_position` | `vehicle.location.updated` | Compatibility alias |
| Socket `alert_created` | `alert.created` | Compatibility alias |

## 26. Recommended OpenAPI Structure

```
openapi/
  openapi.yaml
  paths/
    auth.yaml
    users.yaml
    roles.yaml
    depots.yaml
    vehicles.yaml
    drivers.yaml
    attendance.yaml
    dvir.yaml
    documents.yaml
    routes.yaml
    trips.yaml
    fuel.yaml
    maintenance.yaml
    inventory.yaml
    tracking.yaml
    alerts.yaml
    notifications.yaml
    incidents.yaml
    ev.yaml
    analytics.yaml
    integrations.yaml
  schemas/
    common.yaml
    auth.yaml
    users.yaml
    fleet.yaml
    trip.yaml
    documents.yaml
    fuel.yaml
    maintenance.yaml
    tracking.yaml
    alert.yaml
    ev.yaml
    analytics.yaml
  responses/
    errors.yaml
```

## 27. Final API Architecture Decision

The FMS exposes a versioned REST API through the Node.js/Express modular monolith. API modules align with application bounded modules and PostgreSQL schemas. Redis is used for cache and pub/sub, not as a source of truth. The Python/FastAPI predictive-maintenance service is internal and is called only by the core application. Clients never access PostgreSQL directly.

The API Contract, Database Architecture Specification and OpenAPI document together define the application boundary, persistence boundary and machine-readable interface used for implementation and testing. The combined contract intentionally preserves the old business capabilities while adding the expanded modules, security rules, validation, resilience, analytics, EV and predictive-maintenance interfaces.

## 28. API Contract Summary

| Category | Final status |
|---|---|
| Authentication | Cookie-based JWT for browser clients; refresh rotation; RBAC |
| Fleet | Vehicles, drivers, depots, assignments, attendance, DVIR |
| Operations | Routes, trips, assignment, lifecycle, stops, live state |
| Documents | Upload, signed retrieval, retirement/deletion |
| Fuel | Logs, summaries, anomalies, reconciliation |
| Maintenance | Records, inventory, predictions, risk |
| Tracking | Current location, historical telemetry, flags, Command Center |
| Real-time | Socket.IO operational events + compatibility aliases |
| Alerts / incidents | Alert lifecycle, delivery history, incident lifecycle |
| EV | Battery observations and charging sessions/stations |
| Analytics | Fleet, utilization, fuel, maintenance, trips and alerts |
| Integrations | Telematics, fuel-card, EV webhooks and provider sync |
| Resilience | Idempotency, concurrency, rate limiting, circuit breaking |
| Governance | OpenAPI, contract tests, versioning and deprecation |

## 29. Revisions to the Combined Contract PDF

This file is the combined contract (`Fleet_Management_API_Contract_Combined.pdf`) with these corrections, made so it matches the database schema in `packages/backend/migrations/`:

| Section | Change | Reason |
|---|---|---|
| 3.2 | Client `X-Request-Id` used only if it is a valid UUID | Stored in a UUID audit column |
| 3.5 | Identifiers are each table's `public_id`; enums lowercase; fuel and speed units stated | Schema uses BIGINT keys internally and lowercase enums |
| 3.6 | Error code catalogue added | Codes the board's Definition of Done requires (`CONFLICT_VEHICLE_IN_USE`, `VALIDATION_FLOAT_IN_MONEY_PATH`, ...) were not listed |
| 5.1 | Permission codes defined as seeded in `auth.permissions` | Contract and seed used different names |
| 5.1 | `GET /users/{id}`, `POST /users/{id}/password-reset` and `POST /auth/password` added | Accounts are created without a password; users set their own through a one-time link (FMS-78) |
| 5.2 | `GET /audit-logs` (+ legacy `GET /audit`) added | Audit Log UI (S-10) had no endpoint |
| 5.2 | Cursor paging instead of pages; `action` and `result` filters; actors and entities by public id; `audit:read` without fleet manager | Stable order on an append-only trail that grows while it is read; IDs rule; S-10's roles (FMS-28) |
| 6.2, 6.3 | Vehicle fuel-efficiency requirement; driver depot stored on the user | Required DB columns / single source of depot |
| 7.2 | `/assign` uses new `trip:assign`; overlap rules apply to every assigning write and are DB-enforced | Drivers need `trip:execute` without assignment rights; concurrent-assignment race |
| 9.1, 12.2 | `fuel_type`, `incident_type`, `occurred_at` optional with defaults | Required DB columns the requests did not carry |
| 15 | Webhook de-duplication keys | Telemetry retries were stored twice |
| 16 | Examples use stored enum values; trip uses `scheduled_start/_end`, `en_route`, `version` | `IN_PROGRESS`, `planned_start` and uppercase values did not exist |
| 17, 19 | Specific conflict codes; GPS speed rounding | Generic `409 Conflict`; integer `speed_kmh` column |
| 22, 25 | Documents, idempotency and analytics cache mapped; audit alias | New tables in `012_api_contract_alignment.sql` |
