-- =====================================================================
-- 055_notification_channels.sql
-- Alerts by email, SMS and push (FMS-93, docs/notification-channels.md).
--
-- * alert.push_subscriptions: the browsers (and installed driver apps)
--   a user turned push on in, one row per Web Push endpoint. An endpoint
--   belongs to one user: signing in as someone else on the same browser
--   and turning push on moves it to them.
-- * alert.notifications.next_attempt_at: when a queued email, SMS or push
--   is (next) due. The delivery job claims due rows and records each
--   attempt on the row: delivery_attempts, provider_id,
--   provider_message_id, failure_reason, sent_at or failed_at.
-- * alert.notifications.push_subscription_id: the device a push row is
--   for (one row per device). Cleared if the subscription is removed,
--   and the row is then cancelled.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS alert.push_subscriptions (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id          BIGINT NOT NULL REFERENCES auth.users(id)
                     ON DELETE CASCADE ON UPDATE CASCADE,
    endpoint         TEXT NOT NULL,
    -- The browser's P-256 key and auth secret (base64url), to encrypt for it.
    p256dh           VARCHAR(200) NOT NULL,
    auth_secret      VARCHAR(100) NOT NULL,
    user_agent       VARCHAR(255),
    last_success_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_push_endpoint_length CHECK (length(endpoint) BETWEEN 1 AND 2048)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_push_subscriptions_public_id ON alert.push_subscriptions (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_push_subscriptions_endpoint ON alert.push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON alert.push_subscriptions (user_id);

CREATE OR REPLACE TRIGGER trg_alert_push_subscriptions_updated_at
    BEFORE UPDATE ON alert.push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

ALTER TABLE alert.notifications
    ADD COLUMN IF NOT EXISTS next_attempt_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS push_subscription_id BIGINT REFERENCES alert.push_subscriptions(id)
                                                  ON DELETE SET NULL ON UPDATE CASCADE;

-- The delivery job's queue: email, SMS and push rows still to send, oldest due first.
CREATE INDEX IF NOT EXISTS idx_alert_notifications_due
    ON alert.notifications (next_attempt_at)
    WHERE status = 'queued' AND channel <> 'in_app';

-- +migrate Down

DROP INDEX IF EXISTS alert.idx_alert_notifications_due;
ALTER TABLE IF EXISTS alert.notifications
    DROP COLUMN IF EXISTS push_subscription_id,
    DROP COLUMN IF EXISTS next_attempt_at;
DROP TABLE IF EXISTS alert.push_subscriptions;
