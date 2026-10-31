-- =====================================================================
-- 044_analytics_kpis.sql
-- The fleet KPIs behind the analytics API (FMS-50).
--
-- * analytics.analytics_cache keeps one row per vehicle and Addis Ababa
--   day (period_type 'day'), and now its raw figures as well as the
--   ratios: distance driven in metres, completed trips and how many of
--   them ended on time, fuel in ml and its cost, completed maintenance
--   cost. A range's KPIs are sums of its days, so any from/to is served
--   from the cache. Written by the analytics-refresh jobs, derived data:
--   not audited and safe to truncate and rebuild.
-- * Read-only views in analytics over the operational tables, so the
--   analytics module reads its own schema only (CONVENTIONS rule 3):
--   vehicle_directory, trip_facts, fuel_facts, maintenance_cost_facts and
--   alert_facts. Each is a projection; the aggregation is the module's.
-- =====================================================================

-- +migrate Up

ALTER TABLE analytics.analytics_cache
    ADD COLUMN IF NOT EXISTS distance_m             BIGINT  NOT NULL DEFAULT 0 CHECK (distance_m >= 0),
    ADD COLUMN IF NOT EXISTS trips_completed        INTEGER NOT NULL DEFAULT 0 CHECK (trips_completed >= 0),
    ADD COLUMN IF NOT EXISTS trips_timed            INTEGER NOT NULL DEFAULT 0 CHECK (trips_timed >= 0),
    ADD COLUMN IF NOT EXISTS trips_on_time          INTEGER NOT NULL DEFAULT 0 CHECK (trips_on_time >= 0),
    ADD COLUMN IF NOT EXISTS fuel_ml                BIGINT  NOT NULL DEFAULT 0 CHECK (fuel_ml >= 0),
    ADD COLUMN IF NOT EXISTS fuel_cost_cents        BIGINT  NOT NULL DEFAULT 0 CHECK (fuel_cost_cents >= 0),
    ADD COLUMN IF NOT EXISTS maintenance_cost_cents BIGINT  NOT NULL DEFAULT 0 CHECK (maintenance_cost_cents >= 0);

CREATE INDEX IF NOT EXISTS idx_analytics_cache_period
    ON analytics.analytics_cache(period_type, period_start);

CREATE OR REPLACE VIEW analytics.vehicle_directory AS
SELECT
    v.id AS vehicle_id,
    v.public_id,
    v.registration_number,
    v.make,
    v.model,
    v.status,
    v.fuel_type,
    v.fuel_efficiency_ml_per_km,
    v.health_score,
    v.maintenance_flag,
    v.depot_id,
    d.public_id AS depot_public_id,
    d.name AS depot_name
FROM fleet.vehicles v
JOIN fleet.depots d ON d.id = v.depot_id;

CREATE OR REPLACE VIEW analytics.trip_facts AS
SELECT
    t.id AS trip_id,
    t.vehicle_id,
    t.status,
    t.scheduled_start,
    t.scheduled_end,
    t.actual_start,
    t.actual_end,
    t.actual_distance_km
FROM trip.trips t;

CREATE OR REPLACE VIEW analytics.fuel_facts AS
SELECT f.vehicle_id, f.recorded_at, f.quantity_ml, f.total_cost_cents
FROM fuel.fuel_logs f;

CREATE OR REPLACE VIEW analytics.maintenance_cost_facts AS
SELECT m.vehicle_id, m.completed_at, m.total_cost_cents
FROM maintenance.maintenance_records m
WHERE m.status = 'completed' AND m.completed_at IS NOT NULL;

CREATE OR REPLACE VIEW analytics.alert_facts AS
SELECT
    a.id AS alert_id,
    a.vehicle_id,
    COALESCE(a.depot_id, v.depot_id) AS depot_id,
    a.alert_type,
    a.severity,
    a.status,
    a.created_at,
    a.acknowledged_at
FROM alert.alerts a
LEFT JOIN fleet.vehicles v ON v.id = a.vehicle_id;

-- +migrate Down

DROP VIEW IF EXISTS analytics.alert_facts;
DROP VIEW IF EXISTS analytics.maintenance_cost_facts;
DROP VIEW IF EXISTS analytics.fuel_facts;
DROP VIEW IF EXISTS analytics.trip_facts;
DROP VIEW IF EXISTS analytics.vehicle_directory;
DROP INDEX IF EXISTS analytics.idx_analytics_cache_period;
ALTER TABLE analytics.analytics_cache
    DROP COLUMN IF EXISTS maintenance_cost_cents,
    DROP COLUMN IF EXISTS fuel_cost_cents,
    DROP COLUMN IF EXISTS fuel_ml,
    DROP COLUMN IF EXISTS trips_on_time,
    DROP COLUMN IF EXISTS trips_timed,
    DROP COLUMN IF EXISTS trips_completed,
    DROP COLUMN IF EXISTS distance_m;
