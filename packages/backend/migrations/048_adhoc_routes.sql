-- =====================================================================
-- 048_adhoc_routes.sql
-- One-off trips (FMS-139, docs/flexible-dispatch.md).
--
-- * routes.is_adhoc: a route made for one trip the dispatcher did not
--   plan (POST /trips with a route instead of route_id). Left out of the
--   route lists, so planners never pick it again; readable by id, so the
--   trip's map and history keep their ends.
-- * Active route names stay unique per depot among planned routes only:
--   two one-off trips to Adama on the same day are both allowed.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS is_adhoc BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS trip.ux_trip_routes_depot_name;
CREATE UNIQUE INDEX IF NOT EXISTS ux_trip_routes_depot_name
    ON trip.routes (depot_id, lower(name))
    WHERE is_active AND NOT is_adhoc;

-- +migrate Down

DROP INDEX IF EXISTS trip.ux_trip_routes_depot_name;
CREATE UNIQUE INDEX IF NOT EXISTS ux_trip_routes_depot_name
    ON trip.routes (depot_id, lower(name))
    WHERE is_active;
ALTER TABLE trip.routes DROP COLUMN IF EXISTS is_adhoc;
