-- =====================================================================
-- 068_trip_delay_alert.sql
-- The trip delay alert (FMS-147, docs/eta.md): a trip under way whose
-- live arrival estimate (053) is past its scheduled end by a margin.
--
-- * tracking.rule_thresholds: late means expected more than
--   trip_delay_minutes (15) after the scheduled end; urgent more than
--   trip_delay_urgent_minutes (60). The fleet's row and each depot's that
--   differs, as the other thresholds (035, 060).
-- * trip.trip_etas.delay_level: how late the trip was last alerted as
--   (late or urgent), NULL while it is within the margin. Kept with the
--   estimate, so a trip is alerted once until it recovers.
-- * delay_episode: how many times the trip has fallen late. Each time is
--   an alert of its own.
-- =====================================================================

-- +migrate Up

ALTER TABLE tracking.rule_thresholds
    ADD COLUMN IF NOT EXISTS trip_delay_minutes SMALLINT NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS trip_delay_urgent_minutes SMALLINT NOT NULL DEFAULT 60;

DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_trip_delay_minutes CHECK (trip_delay_minutes BETWEEN 5 AND 240);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE tracking.rule_thresholds ADD CONSTRAINT chk_rule_trip_delay_urgent CHECK (
        trip_delay_urgent_minutes BETWEEN 10 AND 720 AND trip_delay_urgent_minutes > trip_delay_minutes);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE trip.trip_etas
    ADD COLUMN IF NOT EXISTS delay_level VARCHAR(10),
    ADD COLUMN IF NOT EXISTS delay_episode INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
    ALTER TABLE trip.trip_etas ADD CONSTRAINT chk_trip_etas_delay CHECK (
        (delay_level IS NULL OR delay_level IN ('late', 'urgent')) AND delay_episode >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- +migrate Down

ALTER TABLE IF EXISTS trip.trip_etas DROP CONSTRAINT IF EXISTS chk_trip_etas_delay;
ALTER TABLE IF EXISTS trip.trip_etas DROP COLUMN IF EXISTS delay_episode;
ALTER TABLE IF EXISTS trip.trip_etas DROP COLUMN IF EXISTS delay_level;

ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_trip_delay_urgent;
ALTER TABLE tracking.rule_thresholds DROP CONSTRAINT IF EXISTS chk_rule_trip_delay_minutes;
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS trip_delay_urgent_minutes;
ALTER TABLE tracking.rule_thresholds DROP COLUMN IF EXISTS trip_delay_minutes;
