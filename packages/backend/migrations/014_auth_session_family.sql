-- =====================================================================
-- 014_auth_session_family.sql
-- Refresh-token rotation with reuse detection (FMS-05).
--
-- Every login starts a session family; each refresh revokes the
-- presented token and issues a new one in the same family. If a revoked
-- token is presented again, it was stolen or replayed, so the whole
-- family is revoked (api-contract §3.6 AUTH_TOKEN_REVOKED).
--
-- token_hash stores a SHA-256 of the refresh token, never the token.
-- =====================================================================

-- +migrate Up

-- Rows from before this migration each become their own family.
ALTER TABLE auth.refresh_sessions
    ADD COLUMN IF NOT EXISTS family_id UUID NOT NULL DEFAULT gen_random_uuid();
-- No default from here on: the application always sets the family.
ALTER TABLE auth.refresh_sessions
    ALTER COLUMN family_id DROP DEFAULT;

-- Revoking a family, and finding a family's live session.
CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_family
    ON auth.refresh_sessions(family_id)
    WHERE revoked_at IS NULL;

-- +migrate Down

DROP INDEX IF EXISTS auth.idx_auth_refresh_sessions_family;
ALTER TABLE auth.refresh_sessions DROP COLUMN IF EXISTS family_id;
