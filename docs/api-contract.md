# Fleet Management System — Combined API Contract (v1)

**REST API + Internal ML API + Real-Time Events + Webhooks**

Status: canonical architecture and implementation contract, combining the previous API contract with the expanded API specification.

API version: `v1` · Base path: `/api/v1` · Machine-readable companion: OpenAPI 3.0.3

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
| `CONFLICT_DUPLICATE` | 409 | A unique value already exists (constraints without a more specific code); `details` names the field | unique constraint |
| `CONFLICT_DUPLICATE_PLATE` | 409 | Registration number already exists | `uq_fleet_vehicle_registration` |
| `CONFLICT_DUPLICATE_LICENSE` | 409 | Licence number already exists | `drivers_license_number_key` |
| `CONFLICT_VEHICLE_IN_USE` | 409 | Vehicle has an active trip or assignment | API |
| `CONFLICT_DRIVER_IN_USE` | 409 | Driver has an active trip or assignment | API |
| `CONFLICT_DEPOT_NOT_EMPTY` | 409 | Depot still has active vehicles, drivers or users | API |
| `CONFLICT_DRIVER_OVERLAP` | 409 | Driver already assigned in that time window | `ex_trip_driver_overlap` |
| `CONFLICT_VEHICLE_OVERLAP` | 409 | Vehicle already assigned in that time window | `ex_trip_vehicle_overlap` |
| `CONFLICT_VEHICLE_FLAGGED` | 409 | Vehicle has `maintenance_flag` set | API |
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
| `GET /health/ready` | `200` when every dependency check passes, otherwise `503` with `{status: "unavailable", checks: {database: "failed", ...}}` |

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
| `GET /users` | User administration | `users:read` | Paged `User[]` |
| `POST /users` | Create user | `users:write` | `UserCreate` -> `User` |
| `PATCH /users/{user_id}` | Update user | `users:write` | `UserUpdate` -> `User` |
| `GET /roles` | List roles/permissions | `roles:read` | `Role[]` |

Cookies, token lifetimes, rotation and the audit events are described in [auth.md](auth.md).

Permission codes are the `resource:action` values in the "Auth / permission" columns of this document, seeded verbatim in `auth.permissions` (see `001_core_identity.sql` for the role grants).

### 5.2 Audit log

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /audit-logs` | Search the audit trail (screen S-10) | `audit:read` | `user_id,entity_type,entity_id,correlation_id,from,to` + paging -> `AuditLog[]` |
| `GET /audit` | Legacy-compatible alias | `audit:read` | Same as `GET /audit-logs` |

The audit trail is read-only through the API. There is no create, update or delete endpoint; entries are written by the API in the same transaction as each mutation.

## 6. Fleet Management API

### 6.1 Depots

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /depots` | List depots | `depot:read` | Paged `Depot[]` |
| `POST /depots` | Create depot | `depot:write` | `{name,location,...}` -> `Depot` |
| `GET /depots/{depot_id}` | Get depot | `depot:read` | `Depot` |
| `PATCH /depots/{depot_id}` | Update depot | `depot:write` | `DepotUpdate` -> `Depot` |

### 6.2 Vehicles

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /vehicles` | List/search vehicles | `vehicle:read` | `page,page_size,status,depot_id,maintenance_flag,search,sort_by,sort_order` -> `Vehicle[]` |
| `POST /vehicles` | Create vehicle | `vehicle:write` | `VehicleCreate` -> `Vehicle` |
| `GET /vehicles/{vehicle_id}` | Get vehicle | `vehicle:read` | `Vehicle` |
| `PATCH /vehicles/{vehicle_id}` | Update vehicle | `vehicle:write` | `VehicleUpdate` -> `Vehicle` |
| `DELETE /vehicles/{vehicle_id}` | Retire/remove vehicle | `vehicle:delete` | `204`. Soft retire; `409 CONFLICT_VEHICLE_IN_USE` if in use |
| `GET /vehicles/{vehicle_id}/status` | Operational status | `vehicle:read` | `VehicleStatus` |

`VehicleCreate` requires `fuel_efficiency_ml_per_km` (integer ml/km) unless `fuel_type` is `electric`; it is the expected consumption used by fuel reconciliation.

Vehicle rules (FMS-15):

- **Writable fields** (`VehicleCreate`; `VehicleUpdate` is any non-empty subset): `registration_number`, `vin`, `make`, `model`, `year`, `vehicle_type`, `fuel_type`, `fuel_efficiency_ml_per_km`, `depot_id`, `odometer_km`. Required on create: `registration_number`, `make`, `model`, `vehicle_type`, `fuel_type`, `depot_id`, and `fuel_efficiency_ml_per_km` unless electric. `status`, `maintenance_flag` and `health_score` are set by their own workflows (vehicle status FMS-76, maintenance, the ML service); sending them, or any other field, is `400 VALIDATION_FAILED` with `reason: "not_writable"`.
- **Values:** `registration_number` is stored trimmed, upper case, single-spaced, so `aa  3-12345` and `AA 3-12345` are the same plate (`409 CONFLICT_DUPLICATE_PLATE`). `vin` is 17 characters (ISO 3779), unique (`409 CONFLICT_DUPLICATE`, `field: "vin"`). A fractional `fuel_efficiency_ml_per_km` is `400 VALIDATION_FLOAT_IN_MONEY_PATH`. `odometer_km` has at most one decimal and never goes down: a lower reading is `409 CONFLICT_ODOMETER_REGRESSION`. The fuel-efficiency rule is checked on the vehicle as it would be after a `PATCH`.
- **Depot scope:** reads and writes cover the caller's depots only (`depotScope`). A vehicle outside it is `404`; a `depot_id` outside it, on create or `PATCH`, is `400 VALIDATION_FAILED` with `reason: "references_missing_record"`, the same as an unknown depot.
- **Retirement:** `DELETE` sets `status = retired` and `is_active = false` (one audit row) and returns `204`. It is refused with `409 CONFLICT_VEHICLE_IN_USE` while the vehicle is on an `assigned` or `en_route` trip or has an active driver assignment. Retiring a retired vehicle returns `204` and changes nothing. A retired vehicle is left out of `GET /vehicles` unless `status=retired` is asked for, can still be read by id, and cannot be changed (`409 CONFLICT_INVALID_STATE_TRANSITION`). Its plate stays taken.
- **List:** `page` from 1, `page_size` default 25, capped at 100. `search` matches registration number, VIN, make or model (case-insensitive, wildcards literal). `sort_by`: `registration_number` (default), `make`, `model`, `year`, `odometer_km`, `health_score`, `created_at`, `updated_at`; `sort_order` `asc` (default) or `desc`.
- **Events:** `VehicleRegistered`, `VehicleUpdated` (with `changed_fields`) and `VehicleRetired`, each with `vehicle_id` and `depot_id` (public ids).

### 6.3 Drivers, assignments and attendance

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /drivers` | List/search drivers | `driver:read` | `depot_id,license_expiring_before,license_status,search,status` -> `Driver[]` |
| `POST /drivers` | Create driver | `driver:write` | `user_id,license_number,license_expiry,depot_id` -> `Driver` |
| `GET /drivers/me` | The caller's own driver profile (driver PWA) | Authenticated | `Driver`; `404` if the caller is not a driver |
| `GET /drivers/{driver_id}` | Get driver | `driver:read` | `Driver` |
| `PATCH /drivers/{driver_id}` | Update driver | `driver:write` | `DriverUpdate` -> `Driver` |
| `DELETE /drivers/{driver_id}` | Retire driver | `driver:delete` | `204`. Soft retire; preserve historical references; `409 CONFLICT_DRIVER_IN_USE` if in use |
| `POST /driver-vehicle-assignments` | Create driver/vehicle assignment | `assignment:write` | `driver_id,vehicle_id,start_at,end_at` -> `Assignment` |
| `GET /vehicles/{vehicle_id}/assignments` | Assignment history | `assignment:read` | `Assignment[]` |
| `GET /drivers/{driver_id}/assignments` | Driver assignment history | `assignment:read` | `Assignment[]` |
| `GET /attendance` | Attendance history | `attendance:read` | `depot_id,date,driver_id` -> `Attendance[]` |
| `POST /attendance` | Record attendance | `attendance:write` | `driver_id,date,status`; 409 duplicate |
| `GET /attendance/{attendance_id}` | Attendance detail | `attendance:read` | `Attendance` |
| `PATCH /attendance/{attendance_id}` | Update attendance | `attendance:write` | `AttendanceUpdate` -> `Attendance` |

A driver's `depot_id` is their home depot, stored once on the driver's user account (`auth.users.depot_id`). `POST /drivers` and `PATCH /drivers` write it there, and `GET /drivers?depot_id=` filters through it.

Driver rules (FMS-16):

- **`Driver`:** `id`, `user_id`, `full_name`, `email`, `phone`, `depot_id`, `license_number`, `license_category`, `license_expiry` (`YYYY-MM-DD`), `license_status` (`valid`, `expiring_soon` within 30 days, or `expired`, by today's date in Addis Ababa), `hire_date`, `emergency_phone`, `status` (`active` or `retired`), `created_at`, `updated_at`. Name, email and phone are the user account's and change through user administration, not here. Licence and phone are personal data: every driver endpoint needs `driver:read` or more.
- **`POST /drivers`:** `user_id` must be an active account with the `driver` role, in the caller's depots (or without a depot yet); otherwise `400 VALIDATION_FAILED` on `user_id` with `references_missing_record`, `account_not_active` or `not_a_driver`. Also required: `license_number`, `license_expiry`, `depot_id`; optional `license_category`, `hire_date` (not in the future), `emergency_phone`. A second driver for the same account is `409 CONFLICT_DUPLICATE` on `user_id`.
- **Licence number** is stored trimmed, upper case, single-spaced; a duplicate is `409 CONFLICT_DUPLICATE_LICENSE` whatever its case or spacing.
- **`license_category`** is an Ethiopian licence class: `motorcycle`, `automobile`, `public_1`, `public_2`, `public_3`, `dry_cargo_1`, `dry_cargo_2`, `dry_cargo_3`, `liquid_cargo_1`, `liquid_cargo_2`, `special` (anything else is `400 VALIDATION_INVALID_ENUM`). Which vehicle types each class may drive is one table in the fleet module (`LICENSE_CATEGORY_VEHICLE_TYPES`); it is an assumption to confirm with the client.
- **`PATCH /drivers/{id}`:** any non-empty subset of the licence fields, `emergency_phone` and `depot_id`; `user_id` is fixed. A retired driver cannot be changed (`409 CONFLICT_INVALID_STATE_TRANSITION`).
- **Depot scope:** as for vehicles. A driver whose account is outside the caller's depots is `404`; a `depot_id` outside them is `400 references_missing_record`.
- **Retirement** sets `is_active = false` (one audit row), keeps trips and attendance, and leaves the user account as it is. It is refused with `409 CONFLICT_DRIVER_IN_USE` while the driver is on an `assigned` or `en_route` trip or has an active vehicle assignment. Retiring a retired driver returns `204` and changes nothing.
- **List:** `license_expiring_before=YYYY-MM-DD` returns licences expiring before that date (already expired included). `search` matches name, email or licence number. `status` (`active` default, or `retired`), `page`/`page_size` as §18, `sort_by` `license_number` (default), `license_expiry`, `hire_date` or `created_at`.
- **Eligibility** (for trip assignment): the fleet module's `checkDriverEligibility(driverId, at, { vehicleId })` returns `{ eligible, reasons }`. Reasons: `driver_not_found`, `driver_retired`, `account_not_active`, `license_expired` (on `at`'s date in Addis Ababa), and with a vehicle `license_category_missing`, `license_category_not_valid_for_vehicle` or `vehicle_not_found`. Assignment should return them in its `409` details so the dispatcher sees why. `isDriverEligible` is the yes/no shortcut.
- **Events:** `DriverRegistered` and `DriverRetired`, with `driver_id`, `user_id` and `depot_id` (public ids). `DriverLicenseExpiring` (with `license_expiry` and `days_left`) is published by a daily job (06:00 Addis Ababa) 30 and 7 days before a licence expires; its event id is fixed per driver, expiry and day count, so a rerun repeats the id instead of a new fact. Attendance `status` is one of `present`, `absent`, `on_leave`, `late`, `sick`, `other`; the recording user is taken from the session.

### 6.4 DVIR

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /dvir` | Legacy-compatible DVIR command | `dvir:write` | `vehicle_id,trip_id,type,items,issues_found`; canonical behavior |
| `POST /dvir-reports` | Canonical DVIR create | `dvir:write` | `DVIRCreate` -> `DVIRReport` |
| `GET /vehicles/{vehicle_id}/dvir-reports` | DVIR history | `dvir:read` | Paged `DVIRReport[]` |

## 7. Trips and Routes API

### 7.1 Routes

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /routes` | List/search routes | `route:read` | Paged `Route[]` |
| `POST /routes` | Create route | `route:write` | `RouteCreate` -> `Route` |
| `GET /routes/{route_id}` | Get route | `route:read` | `Route` |
| `PATCH /routes/{route_id}` | Update route | `route:write` | `RouteUpdate` -> `Route` |

### 7.2 Trips

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /trips` | Search trips | `trip:read` | filters + paging -> `Trip[]` |
| `POST /trips` | Create trip | `trip:write` | route/vehicle/driver or scheduling data; `Idempotency-Key` |
| `GET /trips/{trip_id}` | Get trip | `trip:read` | `Trip` |
| `PATCH /trips/{trip_id}` | Update trip | `trip:write` | `TripUpdate` -> `Trip` |
| `POST /trips/{trip_id}/assign` | Assign driver and vehicle | `trip:assign` | Runs overlap + vehicle maintenance/flag rules; 409 conflicts |
| `POST /trips/{trip_id}/start` | Start trip | `trip:execute` | Valid state transition -> `Trip` |
| `POST /trips/{trip_id}/end` | End trip | `trip:execute` | Valid state transition -> `Trip` |
| `POST /trips/{trip_id}/status` | Explicit status transition | `trip:execute` | `{status}`; `scheduled/assigned/en_route/completed/cancelled` |
| `POST /trips/{trip_id}/stops/{stop_id}/complete` | Complete trip stop | `trip:execute` | Stop completion -> `TripStop` |
| `GET /trips/{trip_id}/live` | Live trip state | `trip:read` | `TripLiveState` |

Trip assignment preserves the earlier business rules: a driver cannot be assigned to overlapping trips; a vehicle cannot be assigned to overlapping trips; and a vehicle with an active maintenance/operational flag cannot be assigned when the domain rule forbids it. Typical conflicts are `409 CONFLICT_DRIVER_OVERLAP`, `409 CONFLICT_VEHICLE_OVERLAP` and `409 CONFLICT_VEHICLE_FLAGGED`.

The overlap rules hold for any write that puts a trip into `assigned` or `en_route`, including `POST /trips` and `PATCH /trips` with a driver or vehicle, not only `/assign`. The database enforces them as well (`ex_trip_driver_overlap`, `ex_trip_vehicle_overlap`), so two concurrent assignments cannot both succeed. `trip:assign` is separate from `trip:execute` so drivers can start and end their trips without being able to assign trips.

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
| `POST /documents` | Upload document | `document:write` | `multipart/form-data`; jpeg/png/pdf; max 10 MB -> `Document` |
| `GET /documents/{document_id}` | Get document access | `document:read` | Returns metadata + time-limited signed URL |
| `DELETE /documents/{document_id}` | Retire/delete document | `document:delete` | 204; subject to retention policy |

## 9. Fuel Tracking and Reconciliation API

### 9.1 Fuel logs and anomalies

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `POST /fuel-logs` | Record fuel event | `fuel:write` | `vehicle_id,trip_id,fuel_ml,cost_cents,odometer_km`, optional `fuel_type` (defaults to the vehicle's); integer money |
| `GET /fuel-logs` | Search fuel history | `fuel:read` | Paged `FuelLog[]` |
| `GET /vehicles/{vehicle_id}/fuel-summary` | Fuel efficiency summary | `fuel:read` | `FuelSummary` |
| `GET /fuel-anomalies` | List anomalies | `fuel-anomaly:read` | Paged `FuelAnomaly[]` |
| `GET /fuel-anomalies/{anomaly_id}` | Anomaly detail | `fuel-anomaly:read` | `FuelAnomaly` |
| `POST /fuel-anomalies/{anomaly_id}/resolve` | Resolve anomaly | `fuel-anomaly:write` | `FuelAnomaly` |

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
| `PATCH /maintenance-records/{id}` | Update maintenance | `maintenance:write` | `MaintenanceRecordUpdate` -> `MaintenanceRecord` |
| `POST /maintenance-records/{id}/complete` | Complete work | `maintenance:execute` | Completion metadata; clears maintenance flag when applicable |
| `GET /inventory` | Legacy-compatible inventory search | `inventory:read` | `depot_id,below_reorder` -> `InventoryPart[]` |
| `GET /inventory/parts` | Canonical inventory search | `inventory:read` | Paged `InventoryPart[]` |
| `POST /inventory/{part_id}/adjust` | Compatibility stock adjustment | `inventory:write` | Creates inventory movement; resulting stock cannot be negative |
| `POST /inventory/movements` | Record stock movement | `inventory:write` | `InventoryMovement` -> `InventoryMovement` |

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

Retry-prone create and command endpoints support `Idempotency-Key`. The server stores the key, authenticated caller, request hash and outcome for a bounded retention period (`api.idempotency_keys`). Reusing the same key with a different body returns `409 CONFLICT_IDEMPOTENCY_KEY_REUSED`; reusing it while the first request is still running returns `409 CONFLICT_IDEMPOTENCY_IN_PROGRESS`. State-changing operations use database transactions where multiple records must change atomically. Optimistic concurrency using `version`, `updated_at` or ETag should be used where stale writes are possible.

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
| 5.2 | `GET /audit-logs` (+ legacy `GET /audit`) added | Audit Log UI (S-10) had no endpoint |
| 6.2, 6.3 | Vehicle fuel-efficiency requirement; driver depot stored on the user | Required DB columns / single source of depot |
| 7.2 | `/assign` uses new `trip:assign`; overlap rules apply to every assigning write and are DB-enforced | Drivers need `trip:execute` without assignment rights; concurrent-assignment race |
| 9.1, 12.2 | `fuel_type`, `incident_type`, `occurred_at` optional with defaults | Required DB columns the requests did not carry |
| 15 | Webhook de-duplication keys | Telemetry retries were stored twice |
| 16 | Examples use stored enum values; trip uses `scheduled_start/_end`, `en_route`, `version` | `IN_PROGRESS`, `planned_start` and uppercase values did not exist |
| 17, 19 | Specific conflict codes; GPS speed rounding | Generic `409 Conflict`; integer `speed_kmh` column |
| 22, 25 | Documents, idempotency and analytics cache mapped; audit alias | New tables in `012_api_contract_alignment.sql` |
