-- =====================================================================
-- 061_telematics_onboarding.sql
-- The telematics provider slot and device onboarding (FMS-138,
-- docs/telematics.md).
--
-- - integration.gps_devices.last_error_reason / last_error_at: why the
--   device's last refused position was refused (too old, in the future,
--   imprecise, a retired vehicle), shown beside its last seen.
-- - integration.webhook_daily_counts: per provider and Addis Ababa day,
--   the deliveries stored and refused (bad signature, replay, unreadable
--   body) and the positions stored and refused. Counters, not rows per
--   delivery, so forged traffic to a provider's URL cannot fill a table.
-- - integration.unknown_devices: device ids a provider's signed deliveries
--   named that are linked to no vehicle, with when they were first and last
--   seen, so an admin can link them. At most 1,000 per provider (the
--   service stops adding; the counts still count them).
-- - The `fms-simulator` telematics provider: the GPS simulator posts its
--   webhooks as this provider. It is added switched off; the simulator
--   (which refuses NODE_ENV=production) switches it on. Off, or without
--   INTEGRATION_FMS_SIMULATOR_WEBHOOK_SECRET in the environment, its webhook
--   URL answers 404, as for any provider.
-- =====================================================================

-- +migrate Up

ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS last_error_reason VARCHAR(40);
ALTER TABLE integration.gps_devices ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS integration.webhook_daily_counts (
    provider_id          BIGINT NOT NULL REFERENCES integration.external_providers(id)
                         ON DELETE CASCADE ON UPDATE CASCADE,
    day                  DATE NOT NULL,
    deliveries           INTEGER NOT NULL DEFAULT 0,
    deliveries_rejected  INTEGER NOT NULL DEFAULT 0,
    positions_accepted   INTEGER NOT NULL DEFAULT 0,
    positions_rejected   INTEGER NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, day),
    CONSTRAINT chk_webhook_counts_non_negative
        CHECK (deliveries >= 0 AND deliveries_rejected >= 0 AND positions_accepted >= 0 AND positions_rejected >= 0)
);

CREATE TABLE IF NOT EXISTS integration.unknown_devices (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id        BIGINT NOT NULL REFERENCES integration.external_providers(id)
                       ON DELETE CASCADE ON UPDATE CASCADE,
    device_identifier  VARCHAR(255) NOT NULL,
    first_seen_at      TIMESTAMPTZ NOT NULL,
    last_seen_at       TIMESTAMPTZ NOT NULL,
    positions          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (provider_id, device_identifier),
    CONSTRAINT chk_unknown_device_seen CHECK (last_seen_at >= first_seen_at)
);

INSERT INTO integration.external_providers (code, name, provider_type, is_active, configuration)
VALUES ('fms-simulator', 'FMS GPS simulator', 'telematics', FALSE, '{}'::JSONB)
ON CONFLICT (code) DO NOTHING;

-- +migrate Down

DELETE FROM integration.external_providers p
 WHERE p.code = 'fms-simulator'
   AND NOT EXISTS (SELECT 1 FROM integration.gps_devices d WHERE d.provider_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM integration.sync_logs s WHERE s.provider_id = p.id);
DROP TABLE IF EXISTS integration.unknown_devices;
DROP TABLE IF EXISTS integration.webhook_daily_counts;
ALTER TABLE IF EXISTS integration.gps_devices DROP COLUMN IF EXISTS last_error_at;
ALTER TABLE IF EXISTS integration.gps_devices DROP COLUMN IF EXISTS last_error_reason;
