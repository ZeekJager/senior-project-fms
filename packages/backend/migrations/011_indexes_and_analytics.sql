-- =====================================================================
-- 011_indexes_and_analytics.sql
-- Cross-module performance indexes + analytics read views.
-- These objects are read-only projections; operational tables remain the
-- system of record.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS analytics;
REVOKE CREATE ON SCHEMA analytics FROM PUBLIC;

-- ----------------------------
-- Auth / RBAC
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_auth_user_roles_role
    ON auth.user_roles(role_id, user_id);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_user
    ON auth.refresh_sessions(user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_active
    ON auth.refresh_sessions(user_id, expires_at)
    WHERE revoked_at IS NULL;

-- ----------------------------
-- Fleet
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_depot_status
    ON fleet.vehicles(depot_id, status);

CREATE INDEX IF NOT EXISTS idx_fleet_drivers_active
    ON fleet.drivers(is_active);

CREATE INDEX IF NOT EXISTS idx_fleet_assignments_driver_dates
    ON fleet.driver_vehicle_assignments(driver_id, assigned_from DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_assignments_vehicle_dates
    ON fleet.driver_vehicle_assignments(vehicle_id, assigned_from DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_attendance_date
    ON fleet.driver_attendance(attendance_date, driver_id);

CREATE INDEX IF NOT EXISTS idx_fleet_dvir_vehicle_time
    ON fleet.dvir_reports(vehicle_id, submitted_at DESC);

-- ----------------------------
-- Trips
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_trip_trips_vehicle_status
    ON trip.trips(vehicle_id, status);

CREATE INDEX IF NOT EXISTS idx_trip_trips_driver_status
    ON trip.trips(driver_id, status);

CREATE INDEX IF NOT EXISTS idx_trip_trips_schedule
    ON trip.trips(scheduled_start, status);

CREATE INDEX IF NOT EXISTS idx_trip_trip_stops_trip_status
    ON trip.trip_stops(trip_id, status, sequence_number);

-- ----------------------------
-- Fuel
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_fuel_logs_vehicle_time
    ON fuel.fuel_logs(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_driver_time
    ON fuel.fuel_logs(driver_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_trip
    ON fuel.fuel_logs(trip_id);

CREATE INDEX IF NOT EXISTS idx_fuel_anomalies_vehicle_status
    ON fuel.fuel_anomalies(vehicle_id, status, detected_at DESC);

-- ----------------------------
-- Maintenance
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_maintenance_records_vehicle_status
    ON maintenance.maintenance_records(vehicle_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_maintenance_records_technician
    ON maintenance.maintenance_records(technician_id, status);

CREATE INDEX IF NOT EXISTS idx_maintenance_parts_part
    ON maintenance.maintenance_parts(inventory_part_id);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_part_time
    ON maintenance.inventory_movements(inventory_part_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_predictions_vehicle_time
    ON maintenance.maintenance_predictions(vehicle_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_predictions_active
    ON maintenance.maintenance_predictions(vehicle_id, generated_at DESC)
    WHERE status = 'active';

-- ----------------------------
-- Integration
-- ----------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_active_gps_device_vehicle
    ON integration.gps_devices(vehicle_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_provider_time
    ON integration.sync_logs(provider_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_status
    ON integration.sync_logs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fuel_card_transactions_vehicle_time
    ON integration.fuel_card_transactions(vehicle_id, transaction_time DESC);

-- ----------------------------
-- Tracking
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_tracking_gps_pings_vehicle_time
    ON tracking.gps_pings(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_gps_pings_trip_time
    ON tracking.gps_pings(trip_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_current_location_updated
    ON tracking.vehicle_current_location(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_flags_vehicle_time
    ON tracking.telemetry_flags(vehicle_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_flags_open
    ON tracking.telemetry_flags(vehicle_id, observed_at DESC)
    WHERE status = 'open';

-- ----------------------------
-- Alerts / Incidents
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_status_time
    ON alert.alerts(vehicle_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_open_severity
    ON alert.alerts(severity DESC, created_at DESC)
    WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_alert_notifications_pending
    ON alert.notifications(status, queued_at)
    WHERE status IN ('queued', 'sent');

CREATE INDEX IF NOT EXISTS idx_alert_notifications_recipient
    ON alert.notifications(recipient_user_id, queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_vehicle_time
    ON alert.incident_reports(vehicle_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_status
    ON alert.incident_reports(status, occurred_at DESC);

-- ----------------------------
-- EV
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_ev_battery_vehicle_time
    ON ev.ev_battery_logs(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ev_sessions_vehicle_time
    ON ev.charging_sessions(vehicle_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ev_stations_location
    ON ev.charging_stations(latitude, longitude);

-- ----------------------------
-- Audit
-- ----------------------------
CREATE INDEX IF NOT EXISTS idx_audit_user_time
    ON audit.audit_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_entity_time
    ON audit.audit_logs(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_request
    ON audit.audit_logs(request_id);

-- Cross-module FK added here because `trip.trip` is created after `fleet.*`.
DO $$ BEGIN
    ALTER TABLE fleet.dvir_reports
        ADD CONSTRAINT fk_dvir_trip
        FOREIGN KEY (trip_id) REFERENCES trip.trips(id)
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================================
-- Analytics views
-- =====================================================================

CREATE OR REPLACE VIEW analytics.vehicle_current_status AS
SELECT
    v.id AS vehicle_id,
    v.registration_number,
    v.make,
    v.model,
    v.status AS vehicle_status,
    d.name AS depot_name,
    vcl.latitude,
    vcl.longitude,
    vcl.speed_kmh,
    vcl.ignition_on,
    vcl.recorded_at AS location_recorded_at,
    active_trip.id AS active_trip_id,
    active_trip.status AS active_trip_status,
    active_trip.driver_id AS active_driver_id
FROM fleet.vehicles v
JOIN fleet.depots d ON d.id = v.depot_id
LEFT JOIN tracking.vehicle_current_location vcl ON vcl.vehicle_id = v.id
LEFT JOIN LATERAL (
    SELECT t.id, t.status, t.driver_id
    FROM trip.trips t
    WHERE t.vehicle_id = v.id
      AND t.status IN ('scheduled', 'assigned', 'en_route')
    ORDER BY t.scheduled_start NULLS LAST, t.created_at DESC
    LIMIT 1
) active_trip ON TRUE;

CREATE OR REPLACE VIEW analytics.fuel_efficiency_summary AS
SELECT
    f.vehicle_id,
    COUNT(*) AS fuel_event_count,
    SUM(f.quantity_ml) AS total_fuel_ml,
    SUM(f.total_cost_cents) AS total_fuel_cost_cents,
    MIN(f.recorded_at) AS first_recorded_at,
    MAX(f.recorded_at) AS last_recorded_at
FROM fuel.fuel_logs f
GROUP BY f.vehicle_id;

CREATE OR REPLACE VIEW analytics.maintenance_risk_summary AS
SELECT
    p.vehicle_id,
    p.prediction_type,
    p.risk_score,
    p.predicted_failure_type,
    p.model_name,
    p.model_version,
    p.generated_at
FROM maintenance.maintenance_predictions p
WHERE p.status = 'active'
  AND p.id = (
      SELECT p2.id
      FROM maintenance.maintenance_predictions p2
      WHERE p2.vehicle_id = p.vehicle_id
        AND p2.prediction_type = p.prediction_type
        AND p2.status = 'active'
      ORDER BY p2.generated_at DESC, p2.id DESC
      LIMIT 1
  );

CREATE OR REPLACE VIEW analytics.open_alert_summary AS
SELECT
    a.severity,
    COUNT(*) AS alert_count
FROM alert.alerts a
WHERE a.status IN ('open', 'acknowledged')
GROUP BY a.severity;

-- +migrate Down

DROP VIEW IF EXISTS analytics.open_alert_summary;
DROP VIEW IF EXISTS analytics.maintenance_risk_summary;
DROP VIEW IF EXISTS analytics.fuel_efficiency_summary;
DROP VIEW IF EXISTS analytics.vehicle_current_status;
DROP SCHEMA IF EXISTS analytics;

DROP INDEX IF EXISTS idx_audit_request;
DROP INDEX IF EXISTS idx_audit_entity_time;
DROP INDEX IF EXISTS idx_audit_user_time;
DROP INDEX IF EXISTS idx_ev_stations_location;
DROP INDEX IF EXISTS idx_ev_sessions_vehicle_time;
DROP INDEX IF EXISTS idx_ev_battery_vehicle_time;
DROP INDEX IF EXISTS idx_incidents_status;
DROP INDEX IF EXISTS idx_incidents_vehicle_time;
DROP INDEX IF EXISTS idx_alert_notifications_recipient;
DROP INDEX IF EXISTS idx_alert_notifications_pending;
DROP INDEX IF EXISTS idx_alerts_open_severity;
DROP INDEX IF EXISTS idx_alerts_vehicle_status_time;
DROP INDEX IF EXISTS idx_tracking_flags_open;
DROP INDEX IF EXISTS idx_tracking_flags_vehicle_time;
DROP INDEX IF EXISTS idx_tracking_current_location_updated;
DROP INDEX IF EXISTS idx_tracking_gps_pings_trip_time;
DROP INDEX IF EXISTS idx_tracking_gps_pings_vehicle_time;
DROP INDEX IF EXISTS idx_fuel_card_transactions_vehicle_time;
DROP INDEX IF EXISTS idx_integration_sync_logs_status;
DROP INDEX IF EXISTS idx_integration_sync_logs_provider_time;
DROP INDEX IF EXISTS ux_integration_active_gps_device_vehicle;
DROP INDEX IF EXISTS idx_predictions_active;
DROP INDEX IF EXISTS idx_predictions_vehicle_time;
DROP INDEX IF EXISTS idx_inventory_movements_part_time;
DROP INDEX IF EXISTS idx_maintenance_parts_part;
DROP INDEX IF EXISTS idx_maintenance_records_technician;
DROP INDEX IF EXISTS idx_maintenance_records_vehicle_status;
DROP INDEX IF EXISTS idx_fuel_anomalies_vehicle_status;
DROP INDEX IF EXISTS idx_fuel_logs_trip;
DROP INDEX IF EXISTS idx_fuel_logs_driver_time;
DROP INDEX IF EXISTS idx_fuel_logs_vehicle_time;
DROP INDEX IF EXISTS idx_trip_trip_stops_trip_status;
DROP INDEX IF EXISTS idx_trip_trips_schedule;
DROP INDEX IF EXISTS idx_trip_trips_driver_status;
DROP INDEX IF EXISTS idx_trip_trips_vehicle_status;
DROP INDEX IF EXISTS idx_fleet_dvir_vehicle_time;
DROP INDEX IF EXISTS idx_fleet_attendance_date;
DROP INDEX IF EXISTS idx_fleet_assignments_vehicle_dates;
DROP INDEX IF EXISTS idx_fleet_assignments_driver_dates;
DROP INDEX IF EXISTS idx_fleet_drivers_active;
DROP INDEX IF EXISTS idx_fleet_vehicles_depot_status;
DROP INDEX IF EXISTS idx_auth_refresh_sessions_active;
DROP INDEX IF EXISTS idx_auth_refresh_sessions_user;
DROP INDEX IF EXISTS idx_auth_user_roles_role;
