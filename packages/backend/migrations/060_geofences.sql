-- =====================================================================
-- 060_geofences.sql
-- Geofences and route deviation (FMS-90, docs/geofences.md).
--
-- - tracking.geofences: a depot's polygons. keep_in: its vehicles must stay
--   inside (a yard, an operating area); keep_out: they must not enter (a
--   no-go zone). applies: always, or only while the vehicle is on no trip.
--   One ring of [longitude, latitude] as GeoJSON, with its bounding box so a
--   ping far away is ruled out without walking the ring. Soft deleted.
-- - tracking.telemetry_flags.geofence_id: the fence a geofence_violation
--   flag is about. One ongoing flag per vehicle, type and fence, so a
--   vehicle may break two fences at once (ux_telemetry_flags_ongoing).
-- - tracking.rule_thresholds: off route means further than
--   route_deviation_m (500) from the trip's road for route_deviation_pings
--   (3) pings in a row; clear_pings back on it resolve the flag.
-- - geofence:write: draw and change geofences, admin only. tracking:read
--   reads them.
-- =====================================================================

-- +migrate Up

CREATE TABLE IF NOT EXISTS tracking.geofences (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    depot_id     BIGINT NOT NULL REFERENCES fleet.depots(id)
                 ON DELETE RESTRICT ON UPDATE CASCADE,
    name         VARCHAR(120) NOT NULL,
    description  VARCHAR(500),
    kind         VARCHAR(10) NOT NULL,
    applies      VARCHAR(10) NOT NULL DEFAULT 'always',
    polygon      JSONB NOT NULL,
    min_lat      NUMERIC(9,6) NOT NULL,
    max_lat      NUMERIC(9,6) NOT NULL,
    min_lng      NUMERIC(9,6) NOT NULL,
    max_lng      NUMERIC(9,6) NOT NULL,
    area_m2      INTEGER NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    version      INTEGER NOT NULL DEFAULT 0,
    created_by   BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    updated_by   BIGINT REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_geofence_kind CHECK (kind IN ('keep_in', 'keep_out')),
    CONSTRAINT chk_geofence_applies CHECK (applies IN ('always', 'off_trip')),
    CONSTRAINT chk_geofence_polygon CHECK (polygon->>'type' = 'Polygon' AND jsonb_typeof(polygon->'coordinates') = 'array'),
    CONSTRAINT chk_geofence_box CHECK (min_lat <= max_lat AND min_lng <= max_lng),
    CONSTRAINT chk_geofence_area CHECK (area_m2 > 0)
);

-- Names are how people tell fences apart on the map: unique per depot among active ones.
CREATE UNIQUE INDEX IF NOT EXISTS ux_geofences_depot_name
    ON tracking.geofences (depot_id, lower(name))
    WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_geofences_depot_active
    ON tracking.geofences (depot_id)
    WHERE is_active;

CREATE OR REPLACE TRIGGER trg_tracking_geofences_updated_at
    BEFORE UPDATE ON tracking.geofences
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

CREATE OR REPLACE TRIGGER trg_tracking_geofences_version
    BEFORE UPDATE ON tracking.geofences
    FOR EACH ROW EXECUTE FUNCTION shared.bump_version();

ALTER TABLE tracking.telemetry_flags
    ADD COLUMN IF NOT EXISTS geofence_id BIGINT REFERENCES tracking.geofences(id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$ BEGIN
    ALTER TABLE tracking.telemetry_flags ADD CONSTRAINT chk_flag_geofence
        CHECK (geofence_id IS NULL OR flag_type = 'geofence_violation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_telemetry_flags_geofence
    ON tracking.telemetry_flags (geofence_id)
    WHERE geofence_id IS NOT NULL AND resolved_at IS NULL;

-- At most one ongoing flag per vehicle, type and fence (none for other types).
DROP INDEX IF EXISTS tracking.ux_telemetry_flags_ongoing;
CREATE UNIQUE INDEX IF NOT EXISTS ux_telemetry_flags_ongoing
    ON tracking.telemetry_flags (vehicle_id, flag_type, geofence_id) NULLS NOT DISTINCT
    WHERE resolved_at IS NULL;

ALTER TABLE tracking.rule_thresholds
    ADD COLUMN IF NOT EXISTS route_deviation_m SMALLINT NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS route_deviation_pings SMALLINT NOT NULL DEFAULT 3;

DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_route_deviation_m CHECK (route_deviation_m BETWEEN 100 AND 5000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_route_deviation_pings CHECK (route_deviation_pings BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO auth.permissions (code, description) VALUES
    ('geofence:write', 'Draw, change and remove geofences')
ON CONFLICT (code) DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM auth.roles r CROSS JOIN auth.permissions p
 WHERE r.name = 'admin' AND p.code = 'geofence:write'
ON CONFLICT DO NOTHING;

-- +migrate Down

DELETE FROM auth.role_permissions rp
 USING auth.permissions p
 WHERE rp.permission_id = p.id AND p.code = 'geofence:write';
DELETE FROM auth.permissions WHERE code = 'geofence:write';

ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_route_deviation_pings;
ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_route_deviation_m;
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS route_deviation_pings;
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS route_deviation_m;

-- Back to one ongoing flag per vehicle and type: close all but the newest ongoing geofence flag of each vehicle.
UPDATE tracking.telemetry_flags f
   SET resolved_at = greatest(f.observed_at, d.newest_observed_at)
  FROM (SELECT id,
               first_value(observed_at) OVER w AS newest_observed_at,
               row_number() OVER w AS rn
          FROM tracking.telemetry_flags
         WHERE resolved_at IS NULL
        WINDOW w AS (PARTITION BY vehicle_id, flag_type ORDER BY observed_at DESC, id DESC)) d
 WHERE f.id = d.id AND d.rn > 1;
DROP INDEX IF EXISTS tracking.ux_telemetry_flags_ongoing;
CREATE UNIQUE INDEX IF NOT EXISTS ux_telemetry_flags_ongoing
    ON tracking.telemetry_flags (vehicle_id, flag_type)
    WHERE resolved_at IS NULL;
DROP INDEX IF EXISTS tracking.idx_telemetry_flags_geofence;
ALTER TABLE tracking.telemetry_flags DROP CONSTRAINT IF EXISTS chk_flag_geofence;
ALTER TABLE tracking.telemetry_flags DROP COLUMN IF EXISTS geofence_id;

DROP TABLE IF EXISTS tracking.geofences;
