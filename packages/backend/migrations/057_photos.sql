-- =====================================================================
-- 057_photos.sql
-- Photos of people and vehicles (docs/photos.md).
--
-- A user account (an employee: driver, dispatcher, fleet manager, any
-- role) and a vehicle may have one photo. The image is in the document
-- storage under photo_key (never in PostgreSQL); photo_type is its sniffed
-- type and photo_updated_at versions its URL, so a browser's cached copy
-- is replaced the moment the photo changes. No photo, the screens show a
-- placeholder (initials, or the vehicle type's icon).
-- =====================================================================

-- +migrate Up

ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS photo_key        VARCHAR(200),
    ADD COLUMN IF NOT EXISTS photo_type       VARCHAR(20),
    ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

ALTER TABLE fleet.vehicles
    ADD COLUMN IF NOT EXISTS photo_key        VARCHAR(200),
    ADD COLUMN IF NOT EXISTS photo_type       VARCHAR(20),
    ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE auth.users ADD CONSTRAINT chk_user_photo
        CHECK ((photo_key IS NULL) = (photo_type IS NULL) AND (photo_key IS NULL) = (photo_updated_at IS NULL)
               AND (photo_type IS NULL OR photo_type IN ('image/jpeg', 'image/png', 'image/webp')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE fleet.vehicles ADD CONSTRAINT chk_vehicle_photo
        CHECK ((photo_key IS NULL) = (photo_type IS NULL) AND (photo_key IS NULL) = (photo_updated_at IS NULL)
               AND (photo_type IS NULL OR photo_type IN ('image/jpeg', 'image/png', 'image/webp')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- +migrate Down

ALTER TABLE IF EXISTS fleet.vehicles DROP CONSTRAINT IF EXISTS chk_vehicle_photo;
ALTER TABLE IF EXISTS auth.users DROP CONSTRAINT IF EXISTS chk_user_photo;
ALTER TABLE IF EXISTS fleet.vehicles
    DROP COLUMN IF EXISTS photo_updated_at,
    DROP COLUMN IF EXISTS photo_type,
    DROP COLUMN IF EXISTS photo_key;
ALTER TABLE IF EXISTS auth.users
    DROP COLUMN IF EXISTS photo_updated_at,
    DROP COLUMN IF EXISTS photo_type,
    DROP COLUMN IF EXISTS photo_key;
