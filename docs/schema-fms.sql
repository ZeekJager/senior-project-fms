-- =====================================================================
-- SUPERSEDED. This file describes the original flat schema and is kept
-- for history only. It is not valid PostgreSQL as written and no longer
-- matches the database.
--
-- The schema of record is packages/backend/migrations/ (see its README),
-- applied with `make migrate`. Table names there are schema-qualified,
-- e.g. fleet.vehicles, trip.trips, audit.audit_logs.
-- =====================================================================

-- FMS Database Schema
-- Strict adherence to integer-only money/fuel values and soft-delete conventions.

CREATE TABLE depots (
    id INT SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE roles (
    id INT SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    permissions JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
    id INT SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role_id INT NOT NULL,
    depot_id INT DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id),
    FOREIGN KEY (depot_id) REFERENCES depots(id)
);

CREATE TABLE audit_logs (
    id BIGINT SERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    record_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    old_state JSON,
    new_state JSON,
    user_id INT,
    correlation_id CHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE vehicles (
    id INT SERIAL PRIMARY KEY,
    plate_number VARCHAR(50) NOT NULL UNIQUE,
    type VARCHAR(50) NOT NULL,
    capacity INT NOT NULL,
    depot_id INT NOT NULL,
    maintenance_flag BOOLEAN NOT NULL DEFAULT 0,
    fuel_efficiency_ml_per_km INT NOT NULL,
    health_score INT DEFAULT NULL,
    health_score_updated_at TIMESTAMP NULL,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (depot_id) REFERENCES depots(id)
);

CREATE TABLE drivers (
    id INT SERIAL PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    license_number VARCHAR(100) NOT NULL UNIQUE,
    license_expiry DATE NOT NULL,
    depot_id INT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (depot_id) REFERENCES depots(id)
);

CREATE TABLE routes (
    id INT SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    origin VARCHAR(255) NOT NULL,
    destination VARCHAR(255) NOT NULL,
    distance_km INT NOT NULL,
    depot_id INT NOT NULL,
    FOREIGN KEY (depot_id) REFERENCES depots(id)
);

CREATE TABLE trips (
    id INT SERIAL PRIMARY KEY,
    driver_id INT NOT NULL,
    vehicle_id INT NOT NULL,
    route_id INT NOT NULL,
    status ENUM('scheduled', 'assigned', 'en_route', 'completed', 'cancelled') NOT NULL DEFAULT 'scheduled',
    scheduled_start TIMESTAMPTZ NOT NULL,
    scheduled_end TIMESTAMPTZ NOT NULL,
    actual_start TIMESTAMPTZ NULL,
    actual_end TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (route_id) REFERENCES routes(id)
);

CREATE TABLE driver_attendance (
    id INT SERIAL PRIMARY KEY,
    driver_id INT NOT NULL,
    date DATE NOT NULL,
    status ENUM('present', 'absent', 'on_leave') NOT NULL,
    logged_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(driver_id, date),
    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    FOREIGN KEY (logged_by) REFERENCES users(id)
);

CREATE TABLE dvir_reports (
    id INT SERIAL PRIMARY KEY,
    vehicle_id INT NOT NULL,
    driver_id INT NOT NULL,
    trip_id INT NOT NULL,
    type ENUM('pre_trip', 'post_trip') NOT NULL,
    items JSON NOT NULL,
    issues_found BOOLEAN NOT NULL DEFAULT 0,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE maintenance_records (
    id INT SERIAL PRIMARY KEY,
    vehicle_id INT NOT NULL,
    technician_id INT NOT NULL,
    description TEXT NOT NULL,
    labour_hours INT NOT NULL,
    total_cost_cents INT NOT NULL,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (technician_id) REFERENCES users(id)
);

CREATE TABLE inventory_parts (
    id INT SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    stock_quantity INT NOT NULL,
    reorder_level INT NOT NULL,
    depot_id INT NOT NULL,
    CHECK (stock_quantity >= 0),
    FOREIGN KEY (depot_id) REFERENCES depots(id)
);

CREATE TABLE maintenance_parts (
    id INT SERIAL PRIMARY KEY,
    maintenance_record_id INT NOT NULL,
    part_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_cost_cents INT NOT NULL,
    FOREIGN KEY (maintenance_record_id) REFERENCES maintenance_records(id),
    FOREIGN KEY (part_id) REFERENCES inventory_parts(id)
);

CREATE TABLE incident_reports (
    id INT SERIAL PRIMARY KEY,
    driver_id INT NOT NULL,
    vehicle_id INT NOT NULL,
    trip_id INT NOT NULL,
    description TEXT NOT NULL,
    severity ENUM('minor', 'major', 'critical') NOT NULL,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE gps_pings (
    id BIGINT SERIAL PRIMARY KEY,
    vehicle_id INT NOT NULL,
    trip_id INT NOT NULL,
    lat DECIMAL(10, 8) NOT NULL,
    lng DECIMAL(11, 8) NOT NULL,
    speed_kmh SMALLINT CHECK (speed_kmh >= 0) NOT NULL,
    bearing SMALLINT CHECK (speed_kmh >= 0),
    accuracy_m INT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE fuel_logs (
    id INT SERIAL PRIMARY KEY,
    driver_id INT NOT NULL,
    vehicle_id INT NOT NULL,
    trip_id INT NOT NULL,
    fuel_ml INT NOT NULL,
    cost_cents INT NOT NULL,
    odometer_km INT NOT NULL,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE telemetry_flags (
    id INT SERIAL PRIMARY KEY,
    vehicle_id INT NOT NULL,
    trip_id INT NULL,
    flag_type ENUM('speeding', 'idling', 'fuel_variance') NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP NULL,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE TABLE notifications (
    id INT SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    read_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE analytics_cache (
    id INT SERIAL PRIMARY KEY,
    vehicle_id INT NOT NULL,
    period VARCHAR(20) NOT NULL,
    utilisation_pct INT NOT NULL,
    cost_per_km_cents_per_km INT NOT NULL,
    driver_on_time_pct INT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
);
