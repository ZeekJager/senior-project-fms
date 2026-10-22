-- =====================================================================
-- 031_integration_gateway.sql
-- Integration gateway (FMS-85): what the provider registry, webhooks and
-- sync logs need from the integration tables of 006.
--
-- - external_providers.code: the stable slug a provider is known by in
--   webhook URLs (/webhooks/telematics/{code}) and in the names of its
--   secrets (INTEGRATION_<CODE>_WEBHOOK_SECRET). Secrets never live in the
--   table; `configuration` holds only settings (timeout_ms, max_retries).
-- - sync_logs: one row per inbound webhook, so a provider retrying a
--   delivery is a duplicate of the first row (its event id is the
--   external_reference), never a second piece of work.
-- =====================================================================

-- +migrate Up

ALTER TABLE integration.external_providers ADD COLUMN IF NOT EXISTS code VARCHAR(50);

-- Rows from before this migration get a slug from their name and id.
UPDATE integration.external_providers
   SET code = left(trim(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 40) || '-' || id
 WHERE code IS NULL;

ALTER TABLE integration.external_providers ALTER COLUMN code SET NOT NULL;

DO $$ BEGIN
    ALTER TABLE integration.external_providers
        ADD CONSTRAINT chk_provider_code CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_providers_code
    ON integration.external_providers(code);

-- Webhook de-duplication (api-contract §15): one inbound row per provider event.
CREATE UNIQUE INDEX IF NOT EXISTS ux_integration_sync_logs_inbound_reference
    ON integration.sync_logs(provider_id, external_reference)
    WHERE direction = 'inbound' AND external_reference IS NOT NULL;

-- The running sync of a provider, if any (a second manual sync joins it).
CREATE INDEX IF NOT EXISTS idx_integration_sync_logs_running
    ON integration.sync_logs(provider_id, started_at DESC)
    WHERE status = 'started';

-- +migrate Down

DROP INDEX IF EXISTS integration.idx_integration_sync_logs_running;
DROP INDEX IF EXISTS integration.ux_integration_sync_logs_inbound_reference;
DROP INDEX IF EXISTS integration.ux_integration_providers_code;
ALTER TABLE IF EXISTS integration.external_providers DROP CONSTRAINT IF EXISTS chk_provider_code;
ALTER TABLE IF EXISTS integration.external_providers DROP COLUMN IF EXISTS code;
