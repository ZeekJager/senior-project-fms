# FMS API Contract
All endpoints are prefixed with `/api/v1`.
All requests requiring authentication must include the JWT in `HttpOnly` cookies.

## Standard Error Format
```json
{
  "error": {
    "code": "SCREAMING_SNAKE_CASE",
    "message": "Human readable description",
    "correlationId": "uuid-v4"
  }
}
```

## 1. Authentication (track-core)
- `POST /auth/login`: Accepts `email`, `password`. Returns 200, sets access/refresh cookies.
- `POST /auth/refresh`: Uses refresh cookie to set new access cookie.
- `POST /auth/logout`: Clears cookies.

## 2. Core Entities (track-dispatch & track-maintenance)
### 2.1 Vehicles
- `GET /vehicles`: Supports `?depotId=`, `?maintenanceFlag=true`, `?status=active`. Paginated.
- `POST /vehicles`: Accepts `plateNumber`, `type`, `capacity`, `depotId`, `fuelEfficiencyMlPerKm`.
- `PUT /vehicles/:id`: Updates vehicle.
- `DELETE /vehicles/:id`: Soft delete. Fails with `409 CONFLICT_VEHICLE_IN_USE` if assigned.

### 2.2 Drivers
- `GET /drivers`: Supports `?depotId=`, `?licenseExpiringBefore=YYYY-MM-DD`.
- `POST /drivers`: Accepts `userId`, `licenseNumber`, `licenseExpiry`, `depotId`.
- `PUT /drivers/:id`: Updates driver.
- `DELETE /drivers/:id`: Soft delete.

### 2.3 Depots (track-core)
- `GET /depots`: Returns list of depots.
- `POST /depots`: Accepts `name`, `location`.

### 2.4 Attendance (track-dispatch)
- `GET /attendance`: Supports `?depotId=`, `?date=YYYY-MM-DD`.
- `POST /attendance`: Accepts `driverId`, `date`, `status`. Fails with `409 CONFLICT_ATTENDANCE_DUPLICATE`.
- `PUT /attendance/:id`: Updates attendance.

### 2.5 Maintenance & Inventory (track-maintenance)
- `GET /maintenance`: Paginated list of repair records.
- `POST /maintenance`: Accepts `vehicleId`, `description`, `labourHours`, `totalCostCents`. Sets `maintenance_flag = TRUE`.
- `PUT /maintenance/:id`: Marks complete, clears flag.
- `GET /inventory`: Supports `?depotId=`, `?belowReorder=true`.
- `POST /inventory/:id/adjust`: Adjusts `stock_quantity`. Fails if goes below 0.

## 3. Operations (track-dispatch)
### 3.1 Trips
- `GET /trips`: Paginated trip list.
- `POST /trips`: Accepts `routeId`, `scheduledStart`, `scheduledEnd`.
- `PUT /trips/:id`: General updates.
- `PUT /trips/:id/status`: Transitions status (scheduled, assigned, en_route, completed, cancelled).
- `POST /trips/:id/assign`: Assigns `driverId` and `vehicleId`. Runs BR-1/BR-2 overlap logic. Returns `409 CONFLICT_DRIVER_OVERLAP` or `409 CONFLICT_VEHICLE_FLAGGED`.

### 3.2 Documents
- `POST /documents`: Uploads file (jpeg/png/pdf, max 10MB).
- `GET /documents/:id`: Returns time-limited signed URL.

## 4. Driver Actions (track-maintenance)
### 4.1 DVIR & Incidents
- `POST /dvir`: Accepts `vehicleId`, `tripId`, `type`, `items`, `issuesFound`.
- `POST /incidents`: Accepts `vehicleId`, `tripId`, `description`, `severity`.

## 5. Telemetry & Fuel (track-telemetry)
### 5.1 Fuel Logs
- `POST /fuel-logs`: Accepts `vehicleId`, `tripId`, `fuelMl`, `costCents`, `odometerKm`. Rejects floats with `400 VALIDATION_FLOAT_IN_MONEY_PATH`.
- `GET /fuel-logs`: Returns paginated fuel logs.

### 5.2 Analytics & Reconciliation
- `GET /fuel-reconciliation`: Returns actual vs expected fuel usage by vehicle.
- `GET /analytics/utilisation`: Returns cached utilisation stats.

## 6. Real-Time Socket.io Events
- **C->S** `location_update`: `{tripId, lat, lng, speedKmh, bearing, accuracyM}`
- **S->C** `vehicle_position`: `{vehicleId, tripId, lat, lng, speedKmh, bearing, lastSeen}`
- **S->C** `alert_created`: `{alertType, entityId, message, severity}`
