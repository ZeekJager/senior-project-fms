-- =====================================================================
-- 051_attendance_check_in.sql
-- Driver attendance by QR scan (FMS-141, docs/attendance-check-in.md).
--
-- * depots.work_starts_at and late_after_minutes: when the depot's day
--   starts and how long after it a check-in is still on time (08:00 and
--   15 minutes unless set).
-- * driver_attendance.check_in_at / check_out_at and how each was
--   recorded: 'qr' (the driver scanned the depot's code) or 'manual'
--   (someone marked it by hand).
-- * attendance:check-in for drivers (their own day, by scan only; admin
--   holds every permission so it may grant the driver role, but has no
--   driver profile to check in with) and attendance:qr for the staff who
--   show the depot's code. Drivers keep attendance:read and
--   attendance:write from FMS-21 but never the code.
-- =====================================================================

-- +migrate Up

ALTER TABLE fleet.depots
    ADD COLUMN IF NOT EXISTS work_starts_at     TIME     NOT NULL DEFAULT '08:00',
    ADD COLUMN IF NOT EXISTS late_after_minutes SMALLINT NOT NULL DEFAULT 15;

ALTER TABLE fleet.driver_attendance
    ADD COLUMN IF NOT EXISTS check_in_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS check_in_method  VARCHAR(10),
    ADD COLUMN IF NOT EXISTS check_out_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS check_out_method VARCHAR(10);

DO $$ BEGIN
    ALTER TABLE fleet.depots
        ADD CONSTRAINT chk_depot_late_after CHECK (late_after_minutes BETWEEN 0 AND 240);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE fleet.driver_attendance
        ADD CONSTRAINT chk_attendance_check_in
            CHECK ((check_in_at IS NULL) = (check_in_method IS NULL) AND (check_in_method IS NULL OR check_in_method IN ('qr', 'manual'))),
        ADD CONSTRAINT chk_attendance_check_out
            CHECK ((check_out_at IS NULL) = (check_out_method IS NULL) AND (check_out_method IS NULL OR check_out_method IN ('qr', 'manual'))
                   AND (check_out_at IS NULL OR (check_in_at IS NOT NULL AND check_out_at >= check_in_at)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO auth.permissions (code, description) VALUES
    ('attendance:check-in', 'Check in and out by scanning the depot''s attendance code'),
    ('attendance:qr', 'Show the depot''s attendance code for drivers to scan')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM auth.roles r, auth.permissions p
 WHERE (r.name IN ('admin', 'driver') AND p.code = 'attendance:check-in')
    OR (r.name IN ('admin', 'fleet_manager', 'dispatcher', 'depot_admin') AND p.code = 'attendance:qr')
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code IN ('attendance:check-in', 'attendance:qr');
DELETE FROM auth.permissions WHERE code IN ('attendance:check-in', 'attendance:qr');

ALTER TABLE IF EXISTS fleet.driver_attendance DROP CONSTRAINT IF EXISTS chk_attendance_check_out;
ALTER TABLE IF EXISTS fleet.driver_attendance DROP CONSTRAINT IF EXISTS chk_attendance_check_in;
ALTER TABLE IF EXISTS fleet.driver_attendance
    DROP COLUMN IF EXISTS check_out_method,
    DROP COLUMN IF EXISTS check_out_at,
    DROP COLUMN IF EXISTS check_in_method,
    DROP COLUMN IF EXISTS check_in_at;
ALTER TABLE IF EXISTS fleet.depots DROP CONSTRAINT IF EXISTS chk_depot_late_after;
ALTER TABLE IF EXISTS fleet.depots
    DROP COLUMN IF EXISTS late_after_minutes,
    DROP COLUMN IF EXISTS work_starts_at;
