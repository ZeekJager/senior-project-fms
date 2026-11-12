-- =====================================================================
-- 073_trip_risk_facts.sql
-- The trip risk model (FMS-155, docs/ml-trip-risk.md): everything its
-- inputs and labels are computed from, one row per trip, so the core reads
-- analytics.* only, on the read replica.
--
-- * The job (FMS-153): the plan, the schedule, the stops, the cargo and the
--   vehicle's payload, for the job load.
-- * How it went: `late` when it ended more than its depot's
--   trip_delay_minutes (FMS-147) after its scheduled end (null without
--   both); `safety_event` when a speeding flag was raised on it, or its
--   driver had an accident while it ran.
-- * `measured`: its distance was measured (FMS-145). Only measured trips
--   are trained on; every trip counts in a driver's record.
-- No personal data: ids, times and numbers.
-- =====================================================================

-- +migrate Up

CREATE OR REPLACE VIEW analytics.trip_risk_facts AS
SELECT
    t.id AS trip_id,
    t.public_id,
    t.driver_id,
    d.public_id AS driver_public_id,
    t.route_id,
    r.depot_id,
    dp.public_id AS depot_public_id,
    t.status::text AS status,
    t.scheduled_start,
    t.scheduled_end,
    t.actual_start,
    t.actual_end,
    t.planned_distance_km::float8 AS planned_distance_km,
    t.planned_duration_seconds,
    (SELECT count(*)::int FROM trip.trip_stops s WHERE s.trip_id = t.id) AS stop_count,
    t.cargo_weight_kg::float8 AS cargo_weight_kg,
    t.cargo_kind,
    v.payload_capacity_kg::float8 AS payload_capacity_kg,
    t.actual_distance_source IS NOT NULL AS measured,
    CASE
        WHEN t.status::text <> 'completed' OR t.scheduled_end IS NULL OR t.actual_end IS NULL THEN NULL
        ELSE t.actual_end > t.scheduled_end + make_interval(mins => COALESCE(
            (SELECT th.trip_delay_minutes FROM tracking.rule_thresholds th WHERE th.depot_id = r.depot_id),
            (SELECT th.trip_delay_minutes FROM tracking.rule_thresholds th WHERE th.depot_id IS NULL ORDER BY th.id LIMIT 1),
            15))
    END AS late,
    (t.actual_start IS NOT NULL AND (
        EXISTS (SELECT 1 FROM tracking.telemetry_flags f WHERE f.trip_id = t.id AND f.flag_type = 'speeding')
        OR EXISTS (
            SELECT 1 FROM alert.incident_reports i
             WHERE i.driver_id = t.driver_id AND i.incident_type = 'accident'
               AND i.occurred_at >= t.actual_start AND i.occurred_at <= COALESCE(t.actual_end, now()))
    )) AS safety_event
FROM trip.trips t
LEFT JOIN fleet.drivers d ON d.id = t.driver_id
LEFT JOIN trip.routes r ON r.id = t.route_id
LEFT JOIN fleet.depots dp ON dp.id = r.depot_id
LEFT JOIN fleet.vehicles v ON v.id = t.vehicle_id;

-- +migrate Down

DROP VIEW IF EXISTS analytics.trip_risk_facts;
