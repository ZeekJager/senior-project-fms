-- =====================================================================
-- 010_audit.sql
-- Architecture boundary: audit.*
-- Audit rows are append-only. Triggers reject UPDATE, DELETE and
-- TRUNCATE for every role, including the table owner; 012 additionally
-- withholds those privileges from the app role.
-- =====================================================================

-- +migrate Up

CREATE SCHEMA IF NOT EXISTS audit;
REVOKE CREATE ON SCHEMA audit FROM PUBLIC;

CREATE TABLE IF NOT EXISTS audit.audit_logs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Plain FK (no SET NULL / CASCADE): either action would have to UPDATE
    -- audit rows, which the trigger forbids. Users are deactivated via
    -- auth.users.status, never deleted.
    user_id       BIGINT REFERENCES auth.users(id),
    action        VARCHAR(100) NOT NULL,
    entity_type   VARCHAR(100),
    entity_id     BIGINT,
    -- Same uuid the API returns as `correlationId` in error bodies, so a
    -- reported error can be traced to the mutations of that request.
    correlation_id UUID,
    ip_address    INET,
    old_values    JSONB,
    new_values    JSONB,
    details       JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_audit_details CHECK (jsonb_typeof(details) = 'object')
);

CREATE OR REPLACE FUNCTION audit.prevent_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit.audit_logs is append-only; % is not permitted', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER trg_audit_prevent_update_delete
    BEFORE UPDATE OR DELETE ON audit.audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit.prevent_audit_mutation();

CREATE OR REPLACE TRIGGER trg_audit_prevent_truncate
    BEFORE TRUNCATE ON audit.audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit.prevent_audit_mutation();

-- +migrate Down

DROP TRIGGER IF EXISTS trg_audit_prevent_truncate ON audit.audit_logs;
DROP TRIGGER IF EXISTS trg_audit_prevent_update_delete ON audit.audit_logs;
DROP FUNCTION IF EXISTS audit.prevent_audit_mutation();
DROP TABLE IF EXISTS audit.audit_logs;
DROP SCHEMA IF EXISTS audit;
