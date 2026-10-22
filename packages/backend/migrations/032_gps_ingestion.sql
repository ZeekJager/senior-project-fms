-- =====================================================================
-- 032_gps_ingestion.sql
-- GPS ingestion (FMS-88): device credentials and the per-vehicle throttle
-- of VehicleLocationUpdated.
--
-- - integration.gps_devices gets a public id (it was left out of 012) and
--   a device token: only its SHA-256 is stored, as for refresh tokens. A
--   device with a token may report positions for its own vehicle only.
-- - tracking.vehicle_current_location.event_recorded_at: the time of the
--   last position announced as VehicleLocationUpdated. A ping is announced
--   only when it is the vehicle's current position and at least the
--   throttle interval newer than this; the UPDATE that checks it also sets
--   it, so two API instances never announce the same vehicle twice.
-- =====================================================================

-- +migrate Up

ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_gps_devices_public_id ON integration.gps_devices(public_id);

ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS token_hash CHAR(64);
ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS token_issued_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_gps_devices_token
    ON integration.gps_devices(token_hash)
    WHERE token_hash IS NOT NULL;

-- A provider's devices by the identifier its webhooks use.
CREATE INDEX IF NOT EXISTS idx_integration_gps_devices_provider
    ON integration.gps_devices(provider_id, device_identifier);

ALTER TABLE tracking.vehicle_current_location ADD COLUMN IF NOT EXISTS event_recorded_at TIMESTAMPTZ;

-- +migrate Down

ALTER TABLE IF EXISTS tracking.vehicle_current_location DROP COLUMN IF EXISTS event_recorded_at;
DROP INDEX IF EXISTS integration.idx_integration_gps_devices_provider;
DROP INDEX IF EXISTS integration.ux_integration_gps_devices_token;
ALTER TABLE IF EXISTS integration.gps_devices DROP COLUMN IF EXISTS token_issued_at;
ALTER TABLE IF EXISTS integration.gps_devices DROP COLUMN IF EXISTS token_hash;
DROP INDEX IF EXISTS integration.ux_integration_gps_devices_public_id;
ALTER TABLE IF EXISTS integration.gps_devices DROP COLUMN IF EXISTS public_id;
