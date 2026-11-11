-- =====================================================================
-- 067_driver_score_views.sql
-- The driver performance score (FMS-146, docs/analytics.md): what the
-- score reads beyond the driver performance report's views (054), so the
-- analytics module still reads analytics.* only.
--
-- * dvir_facts: each inspection a driver submitted, with its trip and
--   type: the score's DVIR completion counts completed trips that had
--   their driver's pre-trip inspection.
-- * driver_users: each driver's sign-in, so a driver's own score is
--   found from it. A view of its own: 054 re-creates driver_directory
--   with CREATE OR REPLACE, which cannot drop a column added after it.
-- =====================================================================

-- +migrate Up

CREATE OR REPLACE VIEW analytics.dvir_facts AS
SELECT
    r.driver_id,
    r.trip_id,
    r.inspection_type,
    r.submitted_at
FROM fleet.dvir_reports r;

CREATE OR REPLACE VIEW analytics.driver_users AS
SELECT
    d.id AS driver_id,
    d.user_id
FROM fleet.drivers d;

-- +migrate Down

DROP VIEW IF EXISTS analytics.driver_users;
DROP VIEW IF EXISTS analytics.dvir_facts;
