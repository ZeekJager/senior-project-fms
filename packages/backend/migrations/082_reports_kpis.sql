-- =====================================================================
-- 082_reports_kpis.sql
-- Reports, KPIs and scheduled exports (FMS-160, docs/reports.md).
--
-- * Views the reports filter through, beside the FMS-91 ones (which stay
--   as they are): analytics.report_vehicles (with the vehicle type),
--   report_trips (with the route and the driver), report_fuel (with the
--   driver and the trip), report_maintenance (with the workshop, the
--   service programme, when it was scheduled and the failed component),
--   report_failures and route_directory.
-- * analytics.report_filters: filter combinations a user saved by name.
-- * analytics.report_schedules and report_schedule_runs: a report sent
--   daily, weekly or monthly to FMS users, and each run with each
--   recipient's outcome (sent, skipped for lost access, failed).
-- * analytics.report_exports: an export too large to answer at once
--   (over 20,000 rows), made in the background, its file kept 24 hours.
-- * The KPI targets and amber bands as settings (category KPI targets).
-- =====================================================================

-- +migrate Up

CREATE OR REPLACE VIEW analytics.report_vehicles AS
SELECT v.id AS vehicle_id, v.public_id, v.registration_number, v.vehicle_type::text AS vehicle_type, v.fuel_type::text AS fuel_type,
       v.status::text AS status, v.depot_id, d.public_id AS depot_public_id, d.name AS depot_name, v.health_score, v.is_active,
       v.created_at, v.fuel_efficiency_ml_per_km
  FROM fleet.vehicles v
  JOIN fleet.depots d ON d.id = v.depot_id;

CREATE OR REPLACE VIEW analytics.route_directory AS
SELECT r.id AS route_id, r.public_id, r.name, r.depot_id FROM trip.routes r;

CREATE OR REPLACE VIEW analytics.report_trips AS
SELECT t.id AS trip_id, t.public_id, t.vehicle_id, t.driver_id, t.route_id, r.depot_id AS route_depot_id, t.status::text AS status,
       t.scheduled_start, t.scheduled_end, t.actual_start, t.actual_end, t.actual_distance_km, t.planned_distance_km, t.origin, t.destination,
       r.name AS route_name
  FROM trip.trips t
  LEFT JOIN trip.routes r ON r.id = t.route_id;

CREATE OR REPLACE VIEW analytics.report_fuel AS
SELECT f.id AS fuel_log_id, f.vehicle_id, f.driver_id, f.trip_id, t.route_id, f.recorded_at, f.quantity_ml, f.total_cost_cents
  FROM fuel.fuel_logs f
  LEFT JOIN trip.trips t ON t.id = f.trip_id;

CREATE OR REPLACE VIEW analytics.report_maintenance AS
SELECT m.id AS record_id, m.vehicle_id, m.maintenance_type::text AS maintenance_type, m.status::text AS status, m.created_at,
       m.scheduled_at, m.completed_at, m.labor_hours, m.total_cost_cents, NULLIF(btrim(m.workshop), '') AS workshop, m.service_program_id,
       (SELECT fe.component::text FROM maintenance.failure_events fe WHERE fe.maintenance_record_id = m.id ORDER BY fe.occurred_at LIMIT 1) AS component
  FROM maintenance.maintenance_records m;

CREATE OR REPLACE VIEW analytics.report_failures AS
SELECT fe.id AS failure_id, fe.vehicle_id, fe.component::text AS component, fe.unplanned, fe.occurred_at, fe.maintenance_record_id
  FROM maintenance.failure_events fe;

CREATE TABLE IF NOT EXISTS analytics.report_filters (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id   UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id     BIGINT       NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    name        VARCHAR(80)  NOT NULL,
    -- The period and the filters, as GET /reports/{report} takes them: from, to, depot_ids, vehicle_type, ...
    filters     JSONB        NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version     INTEGER      NOT NULL DEFAULT 1,
    CONSTRAINT chk_report_filter_name CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_report_filters_name ON analytics.report_filters (user_id, lower(name)) WHERE is_active;

CREATE TABLE IF NOT EXISTS analytics.report_schedules (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    owner_id        BIGINT        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    name            VARCHAR(80)   NOT NULL,
    report          VARCHAR(30)   NOT NULL,
    -- The filters (a saved filter's or its own); the period is the one before each run (yesterday, last week, last month).
    filters         JSONB         NOT NULL DEFAULT '{}'::jsonb,
    format          VARCHAR(5)    NOT NULL,
    frequency       VARCHAR(10)   NOT NULL,
    -- Weekly: 1 (Monday) to 7; monthly: 1 to 28. The hour is Addis Ababa's.
    day             SMALLINT,
    hour            SMALLINT      NOT NULL DEFAULT 6,
    recipients      BIGINT[]      NOT NULL,
    next_run_at     TIMESTAMPTZ   NOT NULL,
    is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version         INTEGER       NOT NULL DEFAULT 1,
    CONSTRAINT chk_report_schedule_name CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT chk_report_schedule_format CHECK (format IN ('csv', 'xlsx', 'pdf')),
    CONSTRAINT chk_report_schedule_frequency CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT chk_report_schedule_day CHECK (
        (frequency = 'daily' AND day IS NULL)
        OR (frequency = 'weekly' AND day BETWEEN 1 AND 7)
        OR (frequency = 'monthly' AND day BETWEEN 1 AND 28)),
    CONSTRAINT chk_report_schedule_hour CHECK (hour BETWEEN 0 AND 23),
    CONSTRAINT chk_report_schedule_recipients CHECK (cardinality(recipients) BETWEEN 1 AND 50)
);

CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON analytics.report_schedules (next_run_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS analytics.report_schedule_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    schedule_id     BIGINT        NOT NULL REFERENCES analytics.report_schedules(id) ON DELETE CASCADE ON UPDATE CASCADE,
    due_at          TIMESTAMPTZ   NOT NULL,
    period_from     TIMESTAMPTZ   NOT NULL,
    period_to       TIMESTAMPTZ   NOT NULL,
    status          VARCHAR(10)   NOT NULL DEFAULT 'running',
    attempts        SMALLINT      NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    -- Per recipient: {user_id, outcome: sent | skipped | failed, reason, delivered: attached | link}.
    outcomes        JSONB         NOT NULL DEFAULT '[]'::jsonb,
    rows            INTEGER,
    size_bytes      INTEGER,
    error           VARCHAR(500),
    started_at      TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     TIMESTAMPTZ,
    CONSTRAINT chk_report_run_status CHECK (status IN ('running', 'sent', 'partial', 'failed', 'retrying')),
    CONSTRAINT ux_report_run_due UNIQUE (schedule_id, due_at)
);

CREATE INDEX IF NOT EXISTS idx_report_schedule_runs_retry ON analytics.report_schedule_runs (next_attempt_at) WHERE status = 'retrying';

CREATE TABLE IF NOT EXISTS analytics.report_exports (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id     UUID          NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id       BIGINT        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    report        VARCHAR(30)   NOT NULL,
    format        VARCHAR(5)    NOT NULL,
    filters       JSONB         NOT NULL,
    status        VARCHAR(10)   NOT NULL DEFAULT 'queued',
    storage_key   VARCHAR(300),
    filename      VARCHAR(200),
    rows          INTEGER,
    size_bytes    INTEGER,
    error         VARCHAR(500),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at   TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    CONSTRAINT chk_report_export_format CHECK (format IN ('csv', 'xlsx', 'pdf')),
    CONSTRAINT chk_report_export_status CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_report_exports_queued ON analytics.report_exports (created_at) WHERE status = 'queued';

CREATE OR REPLACE TRIGGER trg_report_filters_updated_at BEFORE UPDATE ON analytics.report_filters FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_report_filters_version BEFORE UPDATE ON analytics.report_filters FOR EACH ROW EXECUTE FUNCTION shared.bump_version();
CREATE OR REPLACE TRIGGER trg_report_schedules_updated_at BEFORE UPDATE ON analytics.report_schedules FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();
CREATE OR REPLACE TRIGGER trg_report_schedules_version BEFORE UPDATE ON analytics.report_schedules FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

INSERT INTO settings.definitions (key, label, category, description, type, default_value, rules, is_system, storage) VALUES
    ('kpi_cost_per_km_target_cents', 'Cost per km target', 'KPI targets', 'Fuel and maintenance cost per km driven at or below this is on target.', 'integer', '3500', '{"min": 1, "max": 1000000, "unit": "cents per km"}', TRUE, 'settings'),
    ('kpi_fuel_target_l100km_tenths', 'Fuel use target', 'KPI targets', 'Litres per 100 km, in tenths (300 = 30.0 L/100 km), at or below this is on target.', 'integer', '300', '{"min": 1, "max": 10000, "unit": "tenths of L/100 km"}', TRUE, 'settings'),
    ('kpi_utilisation_target_pct', 'Utilisation target', 'KPI targets', 'The share of available vehicle-days a vehicle was in use, at or above this is on target.', 'integer', '75', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('kpi_availability_target_pct', 'Availability target', 'KPI targets', 'The share of vehicle-days not in downtime, at or above this is on target.', 'integer', '90', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('kpi_on_time_target_pct', 'On-time target', 'KPI targets', 'The share of completed trips ending within 15 minutes of schedule, at or above this is on target.', 'integer', '90', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('kpi_pm_compliance_target_pct', 'Preventive maintenance target', 'KPI targets', 'The share of programmed services done on time, at or above this is on target.', 'integer', '95', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings'),
    ('kpi_incidents_target_per_100k_km', 'Incidents target', 'KPI targets', 'Incidents per 100,000 km at or below this is on target.', 'integer', '5', '{"min": 0, "max": 10000, "unit": "per 100,000 km"}', TRUE, 'settings'),
    ('kpi_vehicles_at_risk_target', 'Vehicles at risk target', 'KPI targets', 'Vehicles with a health score below the alert line, at or below this is on target.', 'integer', '5', '{"min": 0, "max": 10000, "unit": "vehicles"}', TRUE, 'settings'),
    ('kpi_amber_band_pct', 'Amber band', 'KPI targets', 'How far from its target a KPI is amber before it is red, as a share of the target.', 'integer', '10', '{"min": 1, "max": 100, "unit": "%"}', TRUE, 'settings')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT SELECT ON analytics.report_vehicles, analytics.route_directory, analytics.report_trips, analytics.report_fuel,
                        analytics.report_maintenance, analytics.report_failures TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON analytics.report_filters, analytics.report_schedules, analytics.report_schedule_runs, analytics.report_exports TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA analytics TO fms_app;
    END IF;
END $$;

-- +migrate Down

DELETE FROM settings.settings WHERE key LIKE 'kpi\_%';
DELETE FROM settings.definitions WHERE key LIKE 'kpi\_%';
DROP TABLE IF EXISTS analytics.report_exports;
DROP TABLE IF EXISTS analytics.report_schedule_runs;
DROP TABLE IF EXISTS analytics.report_schedules;
DROP TABLE IF EXISTS analytics.report_filters;
DROP VIEW IF EXISTS analytics.report_failures;
DROP VIEW IF EXISTS analytics.report_maintenance;
DROP VIEW IF EXISTS analytics.report_fuel;
DROP VIEW IF EXISTS analytics.report_trips;
DROP VIEW IF EXISTS analytics.route_directory;
DROP VIEW IF EXISTS analytics.report_vehicles;
