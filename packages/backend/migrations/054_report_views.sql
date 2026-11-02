-- =====================================================================
-- 054_report_views.sql
-- Reports and exports (FMS-91, docs/reports.md): the read-only views the
-- monthly reports read, on the read replica, so the analytics module reads
-- analytics.* only and never another module's tables.
--
-- * maintenance_facts: every repair, its type, status, labour and cost
--   (maintenance_cost_facts keeps the completed ones' cost only).
-- * trip_history_facts: every trip with its route, depot (the route's),
--   driver and plan, for the trip history.
-- * driver_directory: drivers with their name and home depot.
-- * telemetry_flag_facts: speeding and idling flags with the driver of the
--   trip they were raised on.
-- * incident_facts: incidents with the driver who had them.
-- * depot_directory: depots by id, with name and code, for a report's
--   heading (vehicle_directory has only depots with vehicles).
-- =====================================================================

-- +migrate Up

CREATE OR REPLACE VIEW analytics.maintenance_facts AS
SELECT
    m.id AS record_id,
    m.vehicle_id,
    m.maintenance_type::text AS maintenance_type,
    m.status::text AS status,
    m.created_at,
    m.completed_at,
    m.labor_hours,
    m.total_cost_cents
FROM maintenance.maintenance_records m;

CREATE OR REPLACE VIEW analytics.trip_history_facts AS
SELECT
    t.id AS trip_id,
    t.public_id,
    t.vehicle_id,
    t.driver_id,
    r.depot_id,
    r.name AS route_name,
    t.origin,
    t.destination,
    t.status::text AS status,
    t.scheduled_start,
    t.scheduled_end,
    t.actual_start,
    t.actual_end,
    t.planned_distance_km,
    t.actual_distance_km
FROM trip.trips t
LEFT JOIN trip.routes r ON r.id = t.route_id;

CREATE OR REPLACE VIEW analytics.driver_directory AS
SELECT
    d.id AS driver_id,
    d.public_id,
    a.full_name,
    a.depot_id,
    dp.public_id AS depot_public_id,
    dp.name AS depot_name
FROM fleet.drivers d
JOIN fleet.driver_accounts a ON a.user_id = d.user_id
LEFT JOIN fleet.depots dp ON dp.id = a.depot_id;

CREATE OR REPLACE VIEW analytics.telemetry_flag_facts AS
SELECT
    f.vehicle_id,
    f.trip_id,
    t.driver_id,
    f.flag_type,
    f.observed_at
FROM tracking.telemetry_flags f
LEFT JOIN trip.trips t ON t.id = f.trip_id;

CREATE OR REPLACE VIEW analytics.incident_facts AS
SELECT
    i.vehicle_id,
    i.driver_id,
    i.incident_type::text AS incident_type,
    i.severity::text AS severity,
    i.occurred_at
FROM alert.incident_reports i;

CREATE OR REPLACE VIEW analytics.depot_directory AS
SELECT d.id AS depot_id, d.public_id, d.name, d.code
FROM fleet.depots d;

-- +migrate Down

DROP VIEW IF EXISTS analytics.depot_directory;
DROP VIEW IF EXISTS analytics.incident_facts;
DROP VIEW IF EXISTS analytics.telemetry_flag_facts;
DROP VIEW IF EXISTS analytics.driver_directory;
DROP VIEW IF EXISTS analytics.trip_history_facts;
DROP VIEW IF EXISTS analytics.maintenance_facts;
