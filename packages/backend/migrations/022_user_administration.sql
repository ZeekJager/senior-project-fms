-- =====================================================================
-- 022_user_administration.sql
-- User and role administration (FMS-78).
--
-- One-time password tokens: an invitation to set a first password (an
-- account created by an admin, or a driver added from the Drivers screen
-- without one) or a reset. Only the SHA-256 of the token is stored; the
-- token itself is shown once to the admin who issued it. A token is single
-- use and expires (setup 72 hours, reset 1 hour; set in code).
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS auth.password_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    purpose     VARCHAR(10) NOT NULL,
    token_hash  CHAR(64) NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_by  BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_password_token_purpose CHECK (purpose IN ('setup', 'reset')),
    CONSTRAINT chk_password_token_expiry CHECK (expires_at > created_at)
);

-- The open tokens of a user: issuing a new one closes the older ones.
CREATE INDEX IF NOT EXISTS idx_password_tokens_open
    ON auth.password_tokens(user_id)
    WHERE used_at IS NULL;

-- +migrate Down

DROP TABLE IF EXISTS auth.password_tokens;
