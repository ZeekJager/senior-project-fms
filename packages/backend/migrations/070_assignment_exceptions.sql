-- =====================================================================
-- 070_assignment_exceptions.sql
-- Approved exceptions to the assignment rules (FMS-151,
-- docs/assignment-exceptions.md).
--
-- * tracking.rule_thresholds: each of the two assignment warnings, the
--   driver's attendance and a previous trip running over, is "warn" (the
--   default: the assignment goes ahead, as before) or "approve" (it is held
--   until a fleet manager decides). The fleet's row and each depot's that
--   differs, as the other thresholds (035, 060, 068).
-- * trip.assignment_exceptions: an assignment held for approval: the trip,
--   the driver and vehicle asked for, the warnings it raised, the
--   dispatcher's reason, and the decision, who made it and why. One pending
--   request per trip. The safety rules (BR-1, BR-2, BR-8) are never held.
-- * assignment-exception:approve: admin and fleet manager.
-- =====================================================================

-- +migrate Up

ALTER TABLE tracking.rule_thresholds
    ADD COLUMN IF NOT EXISTS attendance_exception VARCHAR(10) NOT NULL DEFAULT 'warn',
    ADD COLUMN IF NOT EXISTS overrun_exception VARCHAR(10) NOT NULL DEFAULT 'warn';

DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_assignment_exceptions CHECK (
        attendance_exception IN ('warn', 'approve') AND overrun_exception IN ('warn', 'approve'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS trip.assignment_exceptions (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    trip_id          BIGINT NOT NULL REFERENCES trip.trips(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    driver_id        BIGINT NOT NULL REFERENCES fleet.drivers(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    vehicle_id       BIGINT NOT NULL REFERENCES fleet.vehicles(id)
                     ON DELETE RESTRICT ON UPDATE CASCADE,
    -- The warnings the assignment raised that need approval, as the API names them.
    warnings         JSONB NOT NULL,
    reason           VARCHAR(500) NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'pending',
    requested_by     BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    requested_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by       BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    decision_reason  VARCHAR(500),
    CONSTRAINT chk_assignment_exception_status CHECK (status IN ('pending', 'approved', 'refused', 'withdrawn')),
    CONSTRAINT chk_assignment_exception_warnings CHECK (jsonb_typeof(warnings) = 'array' AND jsonb_array_length(warnings) > 0),
    -- Decided requests say when; a refusal says why.
    CONSTRAINT chk_assignment_exception_decision CHECK (
        (status = 'pending') = (decided_at IS NULL)
        AND (status <> 'refused' OR decision_reason IS NOT NULL))
);

-- One request waits per trip; a new one withdraws the last.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_exception_pending
    ON trip.assignment_exceptions (trip_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_assignment_exceptions_trip
    ON trip.assignment_exceptions (trip_id, requested_at DESC);

INSERT INTO auth.permissions (code, description) VALUES
    ('assignment-exception:approve', 'Approve or refuse an assignment held by an assignment rule')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE r.name IN ('admin', 'fleet_manager') AND p.code = 'assignment-exception:approve'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'assignment-exception:approve';
DELETE FROM auth.permissions WHERE code = 'assignment-exception:approve';

DROP TABLE IF EXISTS trip.assignment_exceptions;

ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_assignment_exceptions;
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS overrun_exception;
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS attendance_exception;
