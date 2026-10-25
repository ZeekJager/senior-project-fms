-- =====================================================================
-- 038_meter_readings.sql
-- Odometer and engine-hour readings over time (FMS-126).
--
-- * meter_readings: every reading of a vehicle's odometer or engine-hour
--   meter, where it came from (a fuel log, a completed repair, a device or
--   telematics provider, the nightly engine-hours job, a person editing the
--   vehicle) and when it was true. Kept for good: a reading is a fact,
--   never edited. A reading lower than an earlier one is kept and marked
--   suspect; the vehicle's odometer follows the highest trusted reading.
-- * source_ref: the fuel log's or repair's public id, the device's public
--   id, or the local day of an engine-hours reading. Unique where it
--   names one source record, so a redelivered event or a re-run job adds
--   nothing twice.
-- * Every vehicle starts with a manual reading of its current odometer, at
--   its last update: the floor later readings are checked against.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE fleet.meter_type AS ENUM ('odometer', 'engine_hours');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE fleet.meter_source AS ENUM ('fuel_log', 'maintenance', 'telematics', 'gps_derived', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fleet.meter_readings (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id   BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                 ON DELETE RESTRICT ON UPDATE CASCADE,
    meter        fleet.meter_type NOT NULL,
    -- km for the odometer, hours for engine hours.
    value        NUMERIC(12,1) NOT NULL CHECK (value >= 0),
    source       fleet.meter_source NOT NULL,
    source_ref   TEXT,
    -- When the reading was true (the fill-up, the repair's completion, the ping, the end of the day).
    recorded_at  TIMESTAMPTZ NOT NULL,
    -- Lower than a trusted reading recorded before it: kept, not trusted.
    suspect      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A vehicle's history of one meter, newest first (GET /vehicles/{id}/meter-readings, the floor check).
CREATE INDEX IF NOT EXISTS idx_meter_readings_vehicle_meter_time
    ON fleet.meter_readings(vehicle_id, meter, recorded_at DESC);

-- One reading per fuel log, repair and engine-hours day.
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_readings_source_record
    ON fleet.meter_readings(vehicle_id, meter, source, source_ref)
    WHERE source IN ('fuel_log', 'maintenance', 'gps_derived');

INSERT INTO fleet.meter_readings (vehicle_id, meter, value, source, recorded_at)
SELECT v.id, 'odometer', v.odometer_km, 'manual', v.updated_at
  FROM fleet.vehicles v
 WHERE NOT EXISTS (SELECT 1 FROM fleet.meter_readings m WHERE m.vehicle_id = v.id AND m.meter = 'odometer');

-- +migrate Down

DROP TABLE IF EXISTS fleet.meter_readings;
DROP TYPE IF EXISTS fleet.meter_source;
DROP TYPE IF EXISTS fleet.meter_type;
