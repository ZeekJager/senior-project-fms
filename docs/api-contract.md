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
| `GET /health/ready` | `200` when every required check passes, otherwise `503` with `{status: "unavailable", checks: {database: "failed", ...}}`. Redis is optional (FMS-72): `checks.redis` is `ok`, `degraded` (down: the API serves from PostgreSQL, `status: "degraded"`, still `200`) or `disabled` (not configured) |

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
- **Order and paging:** newest first, on (`created_at`, row) so rows written in one transaction keep a stable order. `page_size` 1-200 (default 50). `meta.next_cursor` is the `cursor` for the next page, or `null` on the last. A row written while paging is newer than the cursor, so pages never shift, skip or repeat. A cursor that is not one the API issued is `400`, `reason: "invalid_cursor"`.
- **Filters:**
  - `user_id`: the actor's public id.
  - `entity_type`: a schema-qualified table, e.g. `fleet.vehicles`.
  - `entity_id`: the entity's public id. It matches mutation rows of that entity and, for a user account, its sign-in events and role changes.
  - `correlation_id`: one request or job run.
  - `action`, e.g. `UPDATE` or `auth.login_failed`.
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
| `GET /vehicles` | List/search vehicles | `vehicle:read` | `page,page_size,status,depot_id,maintenance_flag,ready_to_dispatch,documents,search,sort_by,sort_order,then_by,then_order` -> `Vehicle[]` |
| `POST /vehicles` | Create vehicle | `vehicle:write` | `VehicleCreate` -> `Vehicle` |
| `GET /vehicles/{vehicle_id}` | Get vehicle | `vehicle:read` | `Vehicle` |
| `PATCH /vehicles/{vehicle_id}` | Update vehicle | `vehicle:write` | `VehicleUpdate` -> `Vehicle` |
| `DELETE /vehicles/{vehicle_id}` | Retire/remove vehicle | `vehicle:delete` | `204`. Soft retire; `409 CONFLICT_VEHICLE_IN_USE` if in use |
| `GET /vehicles/{vehicle_id}/status` | Operational status | `vehicle:read` | `from,to` -> `VehicleStatus` |
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

Vehicle rules (FMS-15):

- **Writable fields** (`VehicleCreate`; `VehicleUpdate` is any non-empty subset): `registration_number`, `vin`, `make`, `model`, `year`, `vehicle_type`, `fuel_type`, `fuel_efficiency_ml_per_km`, `depot_id`, `odometer_km`. Required on create: `registration_number`, `make`, `model`, `vehicle_type`, `fuel_type`, `depot_id`, and `fuel_efficiency_ml_per_km` unless electric. `status`, `maintenance_flag` and `health_score` are set by their own workflows (vehicle status FMS-76, maintenance, the ML service); sending them, or any other field, is `400 VALIDATION_FAILED` with `reason: "not_writable"`.
- **Values:** `registration_number` is stored trimmed, upper case, single-spaced, so `aa  3-12345` and `AA 3-12345` are the same plate (`409 CONFLICT_DUPLICATE_PLATE`). `vin` is 17 characters (ISO 3779), unique (`409 CONFLICT_DUPLICATE`, `field: "vin"`). A fractional `fuel_efficiency_ml_per_km` is `400 VALIDATION_FLOAT_IN_MONEY_PATH`. `odometer_km` has at most one decimal and never goes down: a lower reading is `409 CONFLICT_ODOMETER_REGRESSION`. The fuel-efficiency rule is checked on the vehicle as it would be after a `PATCH`.
- **Depot scope:** reads and writes cover the caller's depots only (`depotScope`). A vehicle outside it is `404`; a `depot_id` outside it, on create or `PATCH`, is `400 VALIDATION_FAILED` with `reason: "references_missing_record"`, the same as an unknown depot.
- **Retirement:** `DELETE` sets `status = retired` and `is_active = false` (one audit row) and returns `204`. It is refused with `409 CONFLICT_VEHICLE_IN_USE` while the vehicle is on an `assigned` or `en_route` trip or has an active driver assignment. Retiring a retired vehicle returns `204` and changes nothing. A retired vehicle is left out of `GET /vehicles` unless `status=retired` is asked for, can still be read by id, and cannot be changed (`409 CONFLICT_INVALID_STATE_TRANSITION`). Its plate stays taken.
- **List:** `page` from 1, `page_size` default 25, capped at 100. `search` matches registration number, VIN, make or model (case-insensitive, wildcards literal). `sort_by`: `registration_number` (default), `make`, `model`, `year`, `odometer_km`, `health_score`, `created_at`, `updated_at`, `status`, `vehicle_type`, `depot` (the depot's name); `sort_order` `asc` (default) or `desc`. `then_by` (the same columns) and `then_order` add a second sort for the rows the first leaves tied; the same column twice is just the first sort.
- **Dispatch and document filters** (FMS-18): `ready_to_dispatch=true` lists the vehicles that can be sent out now: `status` is `active`, `maintenance_flag` is false, no `assigned` or `en_route` trip, and no live document past its `expires_on`. `ready_to_dispatch=false` lists the rest. `documents=expired` lists vehicles with a live document past its date; `documents=expiring` those with one expiring within 30 days (today included, the same window as the expiry warnings); `documents=due` either. A deleted document never counts. Dates are calendar dates in Addis Ababa. The filters combine with every other filter, and `meta.total_items` counts the filtered set, so a client can show each view's count with `page_size=1`.
- **Current trip:** every `Vehicle` carries `current_trip`: the trip it is on now (`assigned` or `en_route`; en route first, then the earliest scheduled), as `{ id, status, origin, destination, scheduled_start }`, or `null`. Read only; it comes from the trip module (FMS-18).
- **Events:** `VehicleRegistered`, `VehicleUpdated` (with `changed_fields`) and `VehicleRetired`, each with `vehicle_id` and `depot_id` (public ids).
- **Concurrency:** `version` and `ETag` / `If-Match` as described under the driver rules (§6.3).

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
| `POST /fuel-logs` | Record fuel event | `fuel:write` | `vehicle_id,quantity_ml,total_cost_cents,odometer_km`; optional `trip_id`, `driver_id`, `fuel_type` (defaults to the vehicle's), `unit_price_cents`, `station_name` -> `201 FuelLog`; `Idempotency-Key`; integer ml and cents |
| `GET /fuel-logs` | Search fuel history | `fuel:read` | `vehicle_id`, `driver_id`, `trip_id`, `from`, `to`, `sort_order` (`desc` default) -> paged `FuelLog[]` |
| `GET /fuel-logs/{fuel_log_id}` | Get a fuel log | `fuel:read` | `FuelLog`; `404` outside your scope |
| `GET /vehicles/{vehicle_id}/fuel-summary` | Fuel efficiency summary | `fuel:read` | `FuelSummary` |
| `GET /fuel-anomalies` | List anomalies | `fuel-anomaly:read` | Paged `FuelAnomaly[]` |
| `GET /fuel-anomalies/{anomaly_id}` | Anomaly detail | `fuel-anomaly:read` | `FuelAnomaly` |
| `POST /fuel-anomalies/{anomaly_id}/resolve` | Resolve anomaly | `fuel-anomaly:write` | `FuelAnomaly` |

Fuel log rules (FMS-39):

- **Who:** drivers hold `fuel:read` and `fuel:write` and are limited by scope, not permission. A driver records only for themselves (`driver_id` is theirs; naming another driver is `400`, `reason: "not_writable"`), only for vehicles of their depot, and lists and fetches only their own logs. Another driver's log by id is `404 NOT_FOUND`, the same body as a missing id. Staff (`admin`, `fleet_manager`, `fleet_owner` and `compliance_officer` see every depot; `depot_admin` and `finance_clerk` their own) see the logs of their depots' vehicles. A driver without a driver profile sees nothing and cannot log.
- **`FuelLog`:** `id`, `vehicle_id`, `driver_id` (null when a clerk logs a purchase for nobody), `trip_id`, `fuel_type`, `quantity_ml`, `unit_price_cents`, `total_cost_cents`, `odometer_km`, `station_name`, `source` (`manual`), `recorded_at`, `created_at`. `source` and the time are the server's: a log is recorded when it is received, so they are `not_writable` like any other unknown field. A log is never edited or deleted.
- **Values:** `quantity_ml` is a whole number from 1 to 2,000,000 and `total_cost_cents` from 0 to 100,000,000; a fraction (`23500.5`) in any ml or cents field, by any name, is `400 VALIDATION_FLOAT_IN_MONEY_PATH`, and a value outside the range is `400 VALIDATION_FAILED` with `reason: "out_of_range"`. `odometer_km` is required, not negative, with at most one decimal.
- **Odometer:** a reading never goes down. One below the vehicle's odometer or below the highest reading any fuel log gave for it is `409 CONFLICT_ODOMETER_REGRESSION` and records nothing; the same reading is fine. The vehicle row is locked while the log is checked, so two logs cannot both pass against the same reading.
- **Vehicle and fuel type:** the vehicle must be a live vehicle in the caller's depots (`400`, `field: "vehicle_id"`, `reason: "references_missing_record"` for one that is missing or elsewhere, `vehicle_retired` for a retired one). An electric vehicle takes no fuel log (`400`, `field: "fuel_type"`, `reason: "not_a_liquid_fuel"`); `fuel_type` defaults to the vehicle's.
- **Trip:** `trip_id`, if sent, must be a trip the caller may see (a driver's own; staff their depots') and, if the trip has a vehicle, this one (`400`, `reason: "trip_vehicle_mismatch"`).
- **Retries:** `Idempotency-Key` (§19) makes a retried POST return the first log with `Idempotent-Replayed: true`; without a key two identical bodies are two fill-ups.
- **Event:** `FuelLogged` (after commit, ordered per vehicle) carries `fuel_log_id`, `vehicle_id`, `driver_id`, `trip_id`, `fuel_type`, `quantity_ml`, `total_cost_cents`, `odometer_km`, `previous_odometer_km` (the log before this one, null for a vehicle's first) and `recorded_at`. The anomaly rules (FMS-82) read it.
- **Vehicle odometer:** a fuel log does not change `fleet.vehicles.odometer_km`; the vehicle's own odometer changes through the vehicle API.

### 9.2 Fuel reconciliation

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /fuel-reconciliation` | Actual vs expected fuel usage | `analytics:read` / `fuel:read` | `vehicle_id,depot_id,from,to` -> reconciliation by vehicle |

`fuel.fuel_logs` stores raw observations. `fuel.fuel_anomalies` stores derived findings. Reconciliation compares actual consumption with expected consumption using trip distance, vehicle efficiency and configured rules. The API must reject floating-point values in money paths; use integer minor units such as cents.

## 10. Maintenance, Inventory and Predictive Maintenance API

### 10.1 Maintenance and inventory

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /maintenance` | Legacy-compatible maintenance list | `maintenance:read` | Paged repair records |
| `POST /maintenance` | Legacy-compatible maintenance create | `maintenance:write` | `vehicle_id,description,labour_hours,cost_cents`; activates maintenance flag |
| `GET /maintenance-records` | Canonical maintenance list | `maintenance:read` | Paged `MaintenanceRecord[]` |
| `POST /maintenance-records` | Canonical maintenance create | `maintenance:write` | `MaintenanceRecordCreate` -> `MaintenanceRecord` |
| `GET /maintenance-records/{id}` | Maintenance detail | `maintenance:read` | `MaintenanceRecord` (also `/maintenance/{id}`) |
| `PATCH /maintenance-records/{id}` | Update maintenance | `maintenance:write` | `MaintenanceRecordUpdate` -> `MaintenanceRecord`; `PUT` too (also `/maintenance/{id}`) |
| `POST /maintenance-records/{id}/complete` | Complete work | `maintenance:execute` | Completion metadata; clears maintenance flag when applicable |
| `GET /inventory` | Legacy-compatible inventory search | `inventory:read` | `depot_id,below_reorder` -> `InventoryPart[]` |
| `GET /inventory/parts` | Canonical inventory search | `inventory:read` | Paged `InventoryPart[]` |
| `POST /inventory/{part_id}/adjust` | Compatibility stock adjustment | `inventory:write` | Creates inventory movement; resulting stock cannot be negative |
| `POST /inventory` | Create part | `inventory:write` | `InventoryPartCreate` -> `201 InventoryPart` |
| `GET /inventory/{part_id}` | Part detail | `inventory:read` | `InventoryPart` |
| `PUT /inventory/{part_id}` | Update part | `inventory:write` | Fields sent (not stock) -> `InventoryPart`; `If-Match` |
| `GET /inventory/{part_id}/movements` | A part's stock ledger | `inventory:read` | Paged `InventoryMovement[]` |
| `POST /inventory/movements` | Record stock movement | `inventory:write` | `InventoryMovement` -> `InventoryMovement` |

Maintenance rules (FMS-22):

- **Paths:** `/maintenance` and `/maintenance-records` are the same API (list, create, read, `PUT`/`PATCH`, `POST .../complete`). Reads need `maintenance:read`; writes `maintenance:write` (technician, depot admin, fleet manager, admin; a dispatcher gets `403`); `POST .../complete` needs `maintenance:execute` (technician, fleet manager, admin). Records are limited to vehicles in the caller's depot scope (`404` otherwise).
- **Create:** `vehicle_id`, `description`, `labour_hours` (at most two decimals) and `total_cost_cents` (whole cents) are required; optional `parts` (`[{part_id, quantity, unit_cost_cents}]`, each part once), `maintenance_type` (default `corrective`), `status` (`scheduled`, `open` (default) or `in_progress`), `priority`, `scheduled_at`, `odometer_km`, `workshop`, `notes`. A fractional number in **any** money-like field (`total_cost_cents`, `unit_cost_cents`, or a stray `totalCost`/`price`/`amount`) is `400 VALIDATION_FLOAT_IN_MONEY_PATH`. A vehicle outside the caller's depots is `400 references_missing_record`; a retired one `409`.
- **Maintenance flag:** creating a record sets the vehicle's `maintenance_flag` in the same transaction. Completing (`completed_at`, `status: completed` or `POST .../complete`) or cancelling it clears the flag in the same transaction, unless other work on the vehicle is still `scheduled`, `open` or `in_progress`. Writes lock the vehicle row, so two completions cannot race the flag. Completed and cancelled records cannot change (`409`).
- **Parts:** each part used is taken off `inventory_parts.stock_quantity`, listed on the record at the cost charged, and written to the inventory ledger (`consumption`, referencing the record). A part must be stocked (`400 references_missing_record`) and shared or in the vehicle's depot (`part_in_other_depot`). Stock never goes below zero (FMS-23): a repair that uses more than the stock record holds is still saved in full, stock stops at 0, and `meta.warnings` includes `{ warning: "LOW_STOCK", part_id, part_number, stock_quantity, shortfall }`. A total below the parts' cost adds `{ warning: "COST_BELOW_PARTS", ... }`.
- **Completion:** `completed_at` is not in the future (5 minutes' clock skew allowed) nor before `started_at`; `completed_by` is the caller. `status: in_progress` sets `started_at`.
- **`MaintenanceRecord`:** `id`, `vehicle_id`, `registration_number`, `maintenance_type`, `description`, `status`, `priority`, `scheduled_at`, `started_at`, `completed_at`, `odometer_km`, `labour_hours`, `total_cost_cents`, `parts_cost_cents`, `workshop`, `notes`, `completed_by`, `parts[]`, `version` (ETag; `If-Match` on `PUT`/`PATCH`), `created_at`, `updated_at`. Lists are newest first (`sort_order=asc` for oldest), filterable by `vehicle_id`, `status`, `open`, `maintenance_type`.
- **Events:** `MaintenanceRecordOpened`, `MaintenanceRecordUpdated` (with `changed_fields`) and `MaintenanceRecordCompleted`, each with `maintenance_record_id`, `vehicle_id` and `maintenance_flag_cleared`.

Inventory rules (FMS-23):

- **Who:** `inventory:read` / `inventory:write`: admin, fleet manager, depot admin, technician. A driver (or dispatcher) gets `403` on every inventory endpoint. A depot-scoped caller sees their depots' parts plus shared stock (`depot_id: null`); creating or changing shared stock needs a fleet-wide role (`403` otherwise).
- **`InventoryPart`:** `id`, `part_number` (trimmed, upper case, unique: `409 CONFLICT_DUPLICATE`), `name`, `description`, `depot_id`, `unit_cost_cents` (whole cents, else `VALIDATION_FLOAT_IN_MONEY_PATH`), `stock_quantity`, `reorder_threshold` (the "reorder level"), `below_reorder` (`stock_quantity <= reorder_threshold`), `stock_status` (`out` at 0, `low` at or below the threshold, `ok`), `is_active`, `version`, `created_at`, `updated_at`.
- **List:** `below_reorder=true` (or `belowReorder=true`) returns only parts at or below their threshold; `stock_status=out|low|ok` returns one status band (`out`: 0; `low`: 1 to the threshold; `ok`: above it), as on the inventory screen (FMS-25). Also `depot_id`, `search` (part number, name), `status` (`active` default, `inactive`, `all`), `sort_by` (`part_number`, `name`, `stock_quantity`), `sort_order`.
- **Stock changes** only through the ledger: opening stock on create (`purchase`), `POST /inventory/{id}/adjust` (`adjustment`) and repairs (`consumption`, FMS-22). Stock is `CHECK (stock_quantity >= 0)`.
- **Adjust:** `{ quantity, reason }`: a non-zero whole number (positive in, negative out) and a reason (3-500 characters). One that would make stock negative is `409 CONFLICT_INSUFFICIENT_STOCK` and changes nothing. Each adjustment writes an audit row with the old and new `stock_quantity`, and a ledger line with the reason. `PUT` cannot set stock (`not_writable`).
- **Events:** `InventoryPartCreated`, `InventoryPartUpdated` (`changed_fields`), `InventoryStockAdjusted` (`quantity_delta`, `stock_quantity`, `reason`), and `InventoryReorderNeeded` when stock falls to or below the threshold from above it, by an adjustment or a repair.

### 10.2 Predictive maintenance

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /maintenance-predictions` | Persisted ML predictions | `prediction:read` | Paged `Prediction[]` |
| `GET /vehicles/{vehicle_id}/maintenance-risk` | Current maintenance risk | `prediction:read` | `MaintenanceRisk` |

### 10.3 Internal ML service contract

```http
POST /internal/ml/predict-maintenance

{
  "vehicle_id": "uuid",
  "as_of": "2026-10-05T07:00:00Z",
  "features": {
    "mileage_km": 128450,
    "engine_temperature_avg": 91.2,
    "fault_code_count_30d": 2,
    "service_overdue_days": 5
  }
}
```

```json
200
{
  "prediction": {
    "risk_score": 0.82,
    "risk_level": "high",
    "prediction_horizon_days": 30,
    "failure_category": "cooling_system",
    "model_version": "pm-2026.10",
    "factors": ["engine_temperature_avg", "service_overdue_days"]
  }
}
```

The ML service never directly updates fleet master data. The Node.js core validates the result and persists `maintenance.maintenance_predictions`. This preserves the selected modular-monolith boundary with one specialized service.

## 11. Tracking and Command Center API

### 11.1 Tracking

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /tracking/vehicles/current` | Current fleet locations | `tracking:read` | `VehicleLocation[]` |
| `POST /tracking/gps-pings` | Telemetry ingestion | `tracking:ingest` | `GPSPoint`; high-volume endpoint; accepted/queued |
| `GET /vehicles/{vehicle_id}/tracking` | Historical GPS | `tracking:read` | `from,to,limit,cursor` -> `GPSPoint[]` |
| `GET /vehicles/{vehicle_id}/telemetry-flags` | Telemetry warnings | `tracking:read` | `TelemetryFlag[]` |
| `GET /command-center/overview` | Operational overview | `command:read` | Vehicle state, alerts, incidents, trip summary |

The previous contract defined a client-to-server Socket.IO `location_update` event. In the canonical contract, high-volume telemetry ingestion is REST/webhook based and Socket.IO is used for server-to-client fan-out. This is a deliberate replacement, not a loss of the capability.

### 11.2 Real-time Socket.IO event contract

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `vehicle.location.updated` | Server -> client | `vehicle_id,lat,lng,speed,heading,recorded_at` | Move live marker |
| `vehicle.status.changed` | Server -> client | `vehicle_id,status,reason` | Operational state update |
| `alert.created` | Server -> client | `Alert` | New alert |
| `alert.updated` | Server -> client | Alert patch | Acknowledge/resolve update |
| `incident.created` | Server -> client | `Incident` | New active incident |
| `trip.updated` | Server -> client | Trip summary | Refresh trip board |
| `location_update` | Client -> server (legacy compatibility only) | `tripId,lat,lng,speedKmh,bearing,accuracyM` | Accepted only if a legacy/mobile client still uses Socket.IO ingestion; canonical ingestion is REST/webhook |
| `vehicle_position` | Server -> client (legacy event name) | `vehicleId,tripId,lat,lng,speedKmh,bearing,lastSeen` | Compatibility alias for `vehicle.location.updated` |
| `alert_created` | Server -> client (legacy event name) | `alertType,entityId,message,severity` | Compatibility alias for `alert.created` |

## 12. Alerts, Notifications and Incidents

An alert is a business event requiring attention. A notification is a delivery attempt for an alert through email, SMS, push or another channel. Incidents represent operational or safety events requiring investigation and lifecycle management.

### 12.1 Alerts and notifications

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /alerts` | Search alerts | `alert:read` | Paged `Alert[]` |
| `GET /alerts/{alert_id}` | Alert detail | `alert:read` | `Alert` |
| `POST /alerts/{alert_id}/acknowledge` | Acknowledge alert | `alert:ack` | `Alert` |
| `POST /alerts/{alert_id}/resolve` | Resolve alert | `alert:resolve` | `Alert` |
| `GET /notifications` | Notification delivery history | `notification:read` | Paged `Notification[]` |

### 12.2 Incidents

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /incidents` | Create incident | `incident:write` | `vehicle_id,trip_id,description,severity`, optional `incident_type` (default `other`), `occurred_at` (default now) -> `Incident` |
| `GET /incidents` | List incidents | `incident:read` | Paged `Incident[]` |
| `GET /incidents/{incident_id}` | Incident detail | `incident:read` | `Incident` |
| `PATCH /incidents/{incident_id}` | Update incident | `incident:write` | `IncidentUpdate` -> `Incident` |

Incident and alert `severity` is one of `low`, `medium`, `high`, `critical`. The reporter is the authenticated user.

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
| `GET /analytics/fleet-summary` | Fleet utilization and status | `analytics:read` | `FleetSummary` |
| `GET /analytics/utilisation` | Legacy-compatible utilization view | `analytics:read` | `UtilisationSummary`; same metrics exposed by fleet-summary |
| `GET /analytics/fuel-efficiency` | Fuel KPIs | `analytics:read` | `FuelEfficiencySummary[]` |
| `GET /analytics/maintenance-risk` | Maintenance risk KPIs | `analytics:read` | `MaintenanceRiskSummary[]` |
| `GET /analytics/trips` | Trip KPIs | `analytics:read` | `TripAnalytics` |
| `GET /analytics/alerts` | Alert KPIs | `analytics:read` | `AlertAnalytics` |

Analytics reads should prefer PostgreSQL read replicas or precomputed analytics views. Responses include the reporting period and, where useful, a `data_freshness` timestamp because replica lag is possible.

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

Retry-prone create and command endpoints support `Idempotency-Key`. The server stores the key, authenticated caller, request hash and outcome for a bounded retention period (`api.idempotency_keys`). Reusing the same key with a different body returns `409 CONFLICT_IDEMPOTENCY_KEY_REUSED`; reusing it while the first request is still running returns `409 CONFLICT_IDEMPOTENCY_IN_PROGRESS`. A retry with the same body gets the stored response again, with `Idempotent-Replayed: true`. Only a 2xx outcome is kept; any other response frees the key. Keys are per user and expire after 24 hours; the daily `idempotency-key-purge` job (02:00) deletes expired rows. The web client sends a UUID key with `api.request(path, { idempotencyKey: true })`, kept across its own token-refresh retry. State-changing operations use database transactions where multiple records must change atomically. Optimistic concurrency using `version`, `updated_at` or ETag should be used where stale writes are possible.

`Idempotency-Key` is optional on the endpoints marked with it. The first request with a key runs; a `2xx` response is stored and replayed to any retry with the same key and body, with the header `Idempotent-Replayed: true`. An error response frees the key, so a corrected retry may reuse it. Keys are per user and kept 24 hours.

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
  -> POST /internal/ml/predict-maintenance
  -> FastAPI validation + model inference
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
