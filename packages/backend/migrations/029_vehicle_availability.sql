-- =====================================================================
-- 029_vehicle_availability.sql
-- Vehicle status and availability (FMS-76).
--
-- * fleet.vehicle_status_history: every status change with its reason,
--   who and when (the audit log has the row diff; this keeps the why).
-- * fleet.trip_assignments: fleet's read model of the trips a vehicle or
--   driver is committed to (assigned or en route), kept by the
--   fleet.trip-assignments consumer from trip events and re-synced daily.
--   Fleet answers "is it free between A and B" from here without reading
--   trip.* (CONVENTIONS rule 3). Both ends of a window count: a trip ending
--   at 08:00 makes the vehicle unavailable for one starting at 08:00.
-- Statuses stay as stored (shared.vehicle_status): the card's
-- "out_of_service" is `inactive`; `decommissioned` is legacy and unused.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS fleet.vehicle_status_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id      BIGINT NOT NULL REFERENCES fleet.vehicles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    from_status     shared.vehicle_status NOT NULL,
    to_status       shared.vehicle_status NOT NULL,
    reason          VARCHAR(500),
    changed_by      BIGINT REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    correlation_id  UUID,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_vehicle_status_history_change CHECK (from_status <> to_status)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_status_history_vehicle
    ON fleet.vehicle_status_history (vehicle_id, changed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fleet.trip_assignments (
    trip_id     UUID PRIMARY KEY,
    vehicle_id  BIGINT REFERENCES fleet.vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
    driver_id   BIGINT REFERENCES fleet.drivers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    status      VARCHAR(20) NOT NULL,
    during      TSTZRANGE NOT NULL,
    synced_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_trip_assignments_status CHECK (status IN ('assigned', 'en_route')),
    CONSTRAINT chk_trip_assignments_during CHECK (NOT isempty(during) AND lower(during) IS NOT NULL AND upper(during) IS NOT NULL)
);

-- btree_gist (migration 012) lets one GiST index combine the id and the window.
CREATE INDEX IF NOT EXISTS idx_trip_assignments_vehicle ON fleet.trip_assignments USING gist (vehicle_id, during);
CREATE INDEX IF NOT EXISTS idx_trip_assignments_driver ON fleet.trip_assignments USING gist (driver_id, during);

-- Start from the trips already assigned or under way; events keep it current from here.
INSERT INTO fleet.trip_assignments (trip_id, vehicle_id, driver_id, status, during)
SELECT public_id, vehicle_id, driver_id, status::text, tstzrange(scheduled_start, scheduled_end, '[]')
  FROM trip.trips
 WHERE status IN ('assigned', 'en_route') AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL
ON CONFLICT (trip_id) DO NOTHING;

-- +migrate Down

DROP TABLE IF EXISTS fleet.trip_assignments;
DROP TABLE IF EXISTS fleet.vehicle_status_history;
