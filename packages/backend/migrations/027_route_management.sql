-- =====================================================================
-- 027_route_management.sql
-- Route management API (FMS-83).
--
-- * routes get the version counter (If-Match on PATCH).
-- * stops: the planned stops between origin and destination, in order, as
--   a JSON array of { name, latitude, longitude }. A route is a template:
--   a trip copies what it needs (origin, destination, planned distance,
--   trip.trip_stops), so editing or retiring a route never rewrites a trip.
-- * A coordinate is a pair: latitude and longitude are both set or neither.
-- * Within a depot, active route names are unique (case-insensitive), so a
--   dispatcher picking "Addis Ababa - Adama" gets one route. Retiring a
--   route frees its name.
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE TRIGGER trg_trip_routes_version
    BEFORE UPDATE ON trip.routes
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

ALTER TABLE trip.routes ADD COLUMN IF NOT EXISTS stops JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_stops
        CHECK (jsonb_typeof(stops) = 'array' AND jsonb_array_length(stops) <= 25);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_origin_pair
        CHECK ((origin_latitude IS NULL) = (origin_longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE trip.routes ADD CONSTRAINT chk_route_destination_pair
        CHECK ((destination_latitude IS NULL) = (destination_longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_trip_routes_depot_name
    ON trip.routes (depot_id, lower(name))
    WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_trip_routes_depot ON trip.routes (depot_id);

-- +migrate Down

DROP INDEX IF EXISTS trip.idx_trip_routes_depot;
DROP INDEX IF EXISTS trip.ux_trip_routes_depot_name;
ALTER TABLE trip.routes DROP CONSTRAINT IF EXISTS chk_route_destination_pair;
ALTER TABLE trip.routes DROP CONSTRAINT IF EXISTS chk_route_origin_pair;
ALTER TABLE trip.routes DROP CONSTRAINT IF EXISTS chk_route_stops;
ALTER TABLE trip.routes DROP COLUMN IF EXISTS stops;
DROP TRIGGER IF EXISTS trg_trip_routes_version ON trip.routes;
ALTER TABLE trip.routes DROP COLUMN IF EXISTS version;
