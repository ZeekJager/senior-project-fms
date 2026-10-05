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
| Business identifiers | UUID strings |
| Timestamps | ISO 8601 UTC |
| Dates | `YYYY-MM-DD` |
| Money | Integer minor units, e.g. cents; do not use floating-point money |
| Coordinates | Latitude -90..90; longitude -180..180 |
| Numerical measurements | Decimal values where fractional physical measurements are required |

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
| `POST /auth/login` | Authenticate user | Public | `{email,password}` -> user/session cookies |
| `POST /auth/refresh` | Rotate/renew session | Refresh cookie | Sets new access/refresh cookies |
| `POST /auth/logout` | Terminate session | Authenticated | Clears session cookies |
| `GET /auth/me` | Current user and permissions | Authenticated | User + permissions |
| `GET /users` | User administration | `users:read` | Paged `User[]` |
| `POST /users` | Create user | `users:write` | `UserCreate` -> `User` |
| `PATCH /users/{user_id}` | Update user | `users:write` | `UserUpdate` -> `User` |
| `GET /roles` | List roles/permissions | `roles:read` | `Role[]` |

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
| `GET /vehicles` | List/search vehicles | `vehicle:read` | `page,page_size,status,depot_id,maintenance_flag,search` -> `Vehicle[]` |
| `POST /vehicles` | Create vehicle | `vehicle:write` | `VehicleCreate` -> `Vehicle` |
| `GET /vehicles/{vehicle_id}` | Get vehicle | `vehicle:read` | `Vehicle` |
| `PATCH /vehicles/{vehicle_id}` | Update vehicle | `vehicle:write` | `VehicleUpdate` -> `Vehicle` |
| `DELETE /vehicles/{vehicle_id}` | Retire/remove vehicle | `vehicle:delete` | Soft delete/retire; 409 if in use |
| `GET /vehicles/{vehicle_id}/status` | Operational status | `vehicle:read` | `VehicleStatus` |

### 6.3 Drivers, assignments and attendance

| Method + path | Purpose | Auth / permission | Request / response |
|---|---|---|---|
| `GET /drivers` | List/search drivers | `driver:read` | `depot_id,license_expiring_before,search` -> `Driver[]` |
| `POST /drivers` | Create driver | `driver:write` | `user_id,license_number,license_expiry,depot_id` -> `Driver` |
| `GET /drivers/{driver_id}` | Get driver | `driver:read` | `Driver` |
| `PATCH /drivers/{driver_id}` | Update driver | `driver:write` | `DriverUpdate` -> `Driver` |
| `DELETE /drivers/{driver_id}` | Retire driver | `driver:delete` | Soft retire; preserve historical references |
| `POST /driver-vehicle-assignments` | Create driver/vehicle assignment | `assignment:write` | `driver_id,vehicle_id,start_at,end_at` -> `Assignment` |
| `GET /vehicles/{vehicle_id}/assignments` | Assignment history | `assignment:read` | `Assignment[]` |
| `GET /drivers/{driver_id}/assignments` | Driver assignment history | `assignment:read` | `Assignment[]` |
| `GET /attendance` | Attendance history | `attendance:read` | `depot_id,date,driver_id` -> `Attendance[]` |
| `POST /attendance` | Record attendance | `attendance:write` | `driver_id,date,status`; 409 duplicate |
| `GET /attendance/{attendance_id}` | Attendance detail | `attendance:read` | `Attendance` |
| `PATCH /attendance/{attendance_id}` | Update attendance | `attendance:write` | `AttendanceUpdate` -> `Attendance` |

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
| `POST /trips/{trip_id}/assign` | Assign driver and vehicle | `trip:execute` | Runs overlap + vehicle maintenance/flag rules; 409 conflicts |
| `POST /trips/{trip_id}/start` | Start trip | `trip:execute` | Valid state transition -> `Trip` |
| `POST /trips/{trip_id}/end` | End trip | `trip:execute` | Valid state transition -> `Trip` |
| `POST /trips/{trip_id}/status` | Explicit status transition | `trip:execute` | `{status}`; `scheduled/assigned/en_route/completed/cancelled` |
| `POST /trips/{trip_id}/stops/{stop_id}/complete` | Complete trip stop | `trip:execute` | Stop completion -> `TripStop` |
| `GET /trips/{trip_id}/live` | Live trip state | `trip:read` | `TripLiveState` |

Trip assignment preserves the earlier business rules: a driver cannot be assigned to overlapping trips; a vehicle cannot be assigned to overlapping trips; and a vehicle with an active maintenance/operational flag cannot be assigned when the domain rule forbids it. Typical conflicts are `409 CONFLICT_DRIVER_OVERLAP` and `409 CONFLICT_VEHICLE_FLAGGED`.

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
| `POST /fuel-logs` | Record fuel event | `fuel:write` | `vehicle_id,trip_id,fuel_ml,cost_cents,odometer_km`; integer money |
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
    "risk_level": "HIGH",
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
| `POST /incidents` | Create incident | `incident:write` | `vehicle_id,trip_id,description,severity` -> `Incident` |
| `GET /incidents` | List incidents | `incident:read` | Paged `Incident[]` |
| `GET /incidents/{incident_id}` | Incident detail | `incident:read` | `Incident` |
| `PATCH /incidents/{incident_id}` | Update incident | `incident:write` | `IncidentUpdate` -> `Incident` |

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
  "fuel_type": "DIESEL",
  "status": "ACTIVE",
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
  "status": "IN_PROGRESS",
  "planned_start": "2026-10-05T08:00:00Z",
  "actual_start": "2026-10-05T08:03:12Z",
  "actual_end": null,
  "stops": []
}
```

### 16.3 Alert

```json
{
  "id": "uuid",
  "vehicle_id": "uuid",
  "type": "FUEL_ANOMALY",
  "severity": "HIGH",
  "status": "OPEN",
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
| Vehicle retirement | Soft retirement; do not destroy historical references |
| Driver retirement | Preserve historical trips and attendance |
| Attendance | Duplicate driver/date submissions -> `409 CONFLICT_ATTENDANCE_DUPLICATE` |
| Trip assignment | Driver overlap -> `409 CONFLICT_DRIVER_OVERLAP` |
| Vehicle assignment | Overlapping vehicle or forbidden maintenance state -> `409 CONFLICT_VEHICLE_FLAGGED` / conflict |
| Trip state | Only legal state transitions accepted |
| Maintenance | Starting active maintenance sets maintenance flag; completion clears it when applicable |
| Inventory | Inventory movement must never result in negative stock |
| Fuel quantity | Positive and within configured operational bounds |
| Fuel / money values | Money as integer minor units; reject floating-point money representations |
| Odometer | Non-negative; downward jumps require correction workflow |
| Coordinates | Latitude -90..90; longitude -180..180 |
| EV charging | Explicit charging state machine; valid session transitions only |
| Writable fields | Only documented writable fields accepted |

## 18. Pagination, Filtering and Sorting

```http
GET /api/v1/vehicles?page=1&page_size=25&status=ACTIVE&depot_id={uuid}&sort_by=registration_number&sort_order=asc
```

```json
{
  "data": [ ... ],
  "meta": { "page": 1, "page_size": 25, "total_items": 148, "total_pages": 6, "request_id": "uuid" }
}
```

Normal resources use `page`/`page_size`. Server page size is capped. Telemetry history uses cursor pagination and enforces maximum time range and record count to protect high-volume queries.

## 19. Idempotency and Concurrency

Retry-prone create and command endpoints support `Idempotency-Key`. The server stores the key, authenticated caller, request hash and outcome for a bounded retention period. Reusing the same key with a different body returns `409 Conflict`. State-changing operations use database transactions where multiple records must change atomically. Optimistic concurrency using `version`, `updated_at` or ETag should be used where stale writes are possible.

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
| Audit | `audit` | audit_logs |
| Analytics | `analytics` | reporting views |

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
