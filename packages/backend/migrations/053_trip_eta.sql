-- =====================================================================
-- 053_trip_eta.sql
-- Live arrival times for trips under way (FMS-86, docs/eta.md).
--
-- * trip_stops.eta: when the vehicle is expected at the stop, from its
--   latest position and the road to it. NULL for a stop it has reached,
--   one without coordinates, or before the first estimate.
-- * trip_etas: one row per trip that has had an estimate: when it is
--   expected at its destination and how far and long that is, as of the
--   position in position_at. A table of its own, not columns on trips:
--   an estimate every 30 seconds must not bump the trip's version (the
--   If-Match a dispatcher's edit carries) or its updated_at.
-- * checked_at_position: the newest position looked at, which spaces the
--   estimates 30 seconds of position time apart even when the routing
--   engine could not be asked (the estimate then keeps its last values).
-- =====================================================================

-- +migrate Up

ALTER TABLE trip.trip_stops ADD COLUMN IF NOT EXISTS eta TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS trip.trip_etas (
    trip_id             BIGINT PRIMARY KEY REFERENCES trip.trips(id)
                        ON DELETE CASCADE ON UPDATE CASCADE,
    -- NULL when the route has no destination coordinates: only its stops are estimated.
    arrival_at          TIMESTAMPTZ,
    remaining_km        NUMERIC(12,3) CHECK (remaining_km IS NULL OR remaining_km >= 0),
    remaining_seconds   INTEGER CHECK (remaining_seconds IS NULL OR remaining_seconds >= 0),
    -- The position the values were worked out from; NULL until the first estimate.
    position_at         TIMESTAMPTZ,
    computed_at         TIMESTAMPTZ,
    checked_at_position TIMESTAMPTZ NOT NULL,
    CONSTRAINT chk_trip_etas_computed CHECK ((position_at IS NULL) = (computed_at IS NULL))
);

-- +migrate Down

DROP TABLE IF EXISTS trip.trip_etas;
ALTER TABLE IF EXISTS trip.trip_stops DROP COLUMN IF EXISTS eta;
