-- =====================================================================
-- 045_route_roads.sql
-- Routes follow the road (FMS-84, docs/routing.md).
--
-- * trip.routes.geometry (from 003): the road through the route's
--   waypoints as a GeoJSON LineString, measured by the routing engine
--   (OSRM) and simplified; NULL until measured.
-- * measured_at: when that road was measured.
-- * distance_source: how distance_km was obtained, 'road' (measured with
--   the geometry) or 'manual' (typed in). A typed distance is never
--   replaced by a measurement; a road distance is, when the waypoints change.
-- * Routes saved so far have only typed distances: 'manual' where set.
-- * A partial index finds the active routes still to be measured.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS measured_at TIMESTAMPTZ;
ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS distance_source VARCHAR(10);

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_distance_source
        CHECK (distance_source IS NULL OR distance_source IN ('road', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_geometry_line
        CHECK (geometry IS NULL OR (geometry->>'type' = 'LineString' AND jsonb_typeof(geometry->'coordinates') = 'array'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_measured
        CHECK ((geometry IS NULL) = (measured_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE trip.routes SET distance_source = 'manual' WHERE distance_km IS NOT NULL AND distance_source IS NULL;

CREATE INDEX IF NOT EXISTS idx_trip_routes_unmeasured
    ON trip.routes (id)
    WHERE is_active AND geometry IS NULL AND origin_latitude IS NOT NULL AND destination_latitude IS NOT NULL;

-- +migrate Down

DROP INDEX IF EXISTS trip.idx_trip_routes_unmeasured;
ALTER TABLE trip.routes DROP CONSTRAINT IF EXISTS chk_route_measured;
ALTER TABLE trip.routes DROP CONSTRAINT IF EXISTS chk_route_geometry_line;
ALTER TABLE trip.routes DROP CONSTRAINT IF EXISTS chk_route_distance_source;
ALTER TABLE trip.routes DROP COLUMN IF EXISTS distance_source;
ALTER TABLE trip.routes DROP COLUMN IF EXISTS measured_at;
