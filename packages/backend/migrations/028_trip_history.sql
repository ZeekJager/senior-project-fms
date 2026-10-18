-- =====================================================================
-- 028_trip_history.sql
-- Trip API and trip history (FMS-30).
--
-- * Trip history pages by keyset on (start, id), newest first: start is
--   scheduled_start, or created_at for a draft not scheduled yet. The
--   expression index serves both the order and the date-range filter.
-- * A trip's depot is its route's depot, so depot scope joins on route_id.
-- =====================================================================

-- +migrate Up

CREATE INDEX IF NOT EXISTS idx_trip_trips_history
    ON trip.trips ((COALESCE(scheduled_start, created_at)), id);

CREATE INDEX IF NOT EXISTS idx_trip_trips_route
    ON trip.trips (route_id);

-- +migrate Down

DROP INDEX IF EXISTS trip.idx_trip_trips_route;
DROP INDEX IF EXISTS trip.idx_trip_trips_history;
