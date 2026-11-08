-- =====================================================================
-- 063_encrypt_personal_data.sql
-- Driver data protection (FMS-104, docs/driver-data-protection.md):
-- licence numbers and phone numbers are encrypted at rest with pgcrypto.
--
-- * privacy.encrypt_text / decrypt_text / blind_index: AES-256 (OpenPGP
--   symmetric) with the key the application gives each connection as the
--   setting fms.data_key. The database never stores the key, so a copy of
--   the data or of a backup cannot be read without it. A connection without
--   the key gets error 55000 instead of data.
-- * Encrypted values read 'enc:v1:<base64>'. decrypt_text passes anything
--   else through unchanged, so a row written before this migration still
--   reads (and the next write encrypts it).
-- * Triggers encrypt on INSERT and UPDATE, so no write path needs changing:
--   fleet.drivers.license_number and emergency_phone, auth.users.phone.
-- * Uniqueness of a licence number moves to license_number_idx, an HMAC of
--   it (a blind index): random ciphertext cannot be unique, and equal
--   numbers still collide.
-- * Existing rows are encrypted by this migration. If any exist, the session
--   running it needs the key: SET fms.data_key = '<DATA_ENCRYPTION_KEY>'
--   (the migration runner, npm run migrate, does it from the environment).
--   With none, it needs nothing.
-- * Down decrypts the rows again (the key is needed the same way).
-- =====================================================================

-- +migrate Up

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS privacy;

-- The key of this session, or an error. Never returns a short key: a mistyped
-- one would encrypt data nobody can read back.
CREATE OR REPLACE FUNCTION privacy.data_key()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    k TEXT := current_setting('fms.data_key', TRUE);
BEGIN
    IF k IS NULL OR length(k) < 32 THEN
        RAISE EXCEPTION 'fms.data_key is not set on this connection (DATA_ENCRYPTION_KEY): personal data can be neither read nor written'
            USING ERRCODE = '55000';
    END IF;
    RETURN k;
END;
$$;

CREATE OR REPLACE FUNCTION privacy.encrypt_text(plain TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN plain IS NULL THEN NULL
        WHEN plain LIKE 'enc:v1:%' THEN plain
        ELSE 'enc:v1:' || replace(encode(pgp_sym_encrypt(plain, privacy.data_key(), 'cipher-algo=aes256, compress-algo=0'), 'base64'), E'\n', '')
    END
$$;

CREATE OR REPLACE FUNCTION privacy.decrypt_text(stored TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN stored IS NULL THEN NULL
        WHEN stored LIKE 'enc:v1:%' THEN pgp_sym_decrypt(decode(substr(stored, 8), 'base64'), privacy.data_key())
        ELSE stored
    END
$$;

-- HMAC-SHA256 of the plain value under the key (with a purpose suffix, so the
-- index is not the cipher's key): equal values give equal indexes.
CREATE OR REPLACE FUNCTION privacy.blind_index(plain TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT CASE WHEN plain IS NULL THEN NULL ELSE encode(hmac(plain, privacy.data_key() || ':blind-index', 'sha256'), 'hex') END
$$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT USAGE ON SCHEMA privacy TO fms_app;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA privacy TO fms_app;
    END IF;
END $$;

-- Room for ciphertext, and the licence number's blind index.
ALTER TABLE fleet.drivers ALTER COLUMN license_number TYPE TEXT;
ALTER TABLE fleet.drivers ALTER COLUMN emergency_phone TYPE TEXT;
ALTER TABLE fleet.drivers ADD COLUMN IF NOT EXISTS license_number_idx VARCHAR(64);
ALTER TABLE auth.users ALTER COLUMN phone TYPE TEXT;

CREATE OR REPLACE FUNCTION fleet.encrypt_driver_personal_data()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.license_number IS NOT NULL THEN
        IF NEW.license_number NOT LIKE 'enc:v1:%' THEN
            NEW.license_number_idx := privacy.blind_index(NEW.license_number);
            NEW.license_number := privacy.encrypt_text(NEW.license_number);
        ELSIF NEW.license_number_idx IS NULL THEN
            NEW.license_number_idx := privacy.blind_index(privacy.decrypt_text(NEW.license_number));
        END IF;
    END IF;
    NEW.emergency_phone := privacy.encrypt_text(NEW.emergency_phone);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auth.encrypt_user_personal_data()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.phone := privacy.encrypt_text(NEW.phone);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drivers_encrypt_personal_data ON fleet.drivers;
CREATE TRIGGER trg_drivers_encrypt_personal_data
    BEFORE INSERT OR UPDATE OF license_number, emergency_phone ON fleet.drivers
    FOR EACH ROW EXECUTE FUNCTION fleet.encrypt_driver_personal_data();

DROP TRIGGER IF EXISTS trg_users_encrypt_personal_data ON auth.users;
CREATE TRIGGER trg_users_encrypt_personal_data
    BEFORE INSERT OR UPDATE OF phone ON auth.users
    FOR EACH ROW EXECUTE FUNCTION auth.encrypt_user_personal_data();

-- Encrypt what is there: setting a column to itself fires the trigger.
UPDATE fleet.drivers SET license_number = license_number WHERE license_number NOT LIKE 'enc:v1:%' OR license_number_idx IS NULL;
UPDATE fleet.drivers SET emergency_phone = emergency_phone WHERE emergency_phone IS NOT NULL AND emergency_phone NOT LIKE 'enc:v1:%';
UPDATE auth.users SET phone = phone WHERE phone IS NOT NULL AND phone NOT LIKE 'enc:v1:%';

-- Unique on the blind index instead of on the (random) ciphertext.
ALTER TABLE fleet.drivers DROP CONSTRAINT IF EXISTS drivers_license_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_drivers_license_number_idx ON fleet.drivers(license_number_idx);

-- +migrate Down

DROP TRIGGER IF EXISTS trg_drivers_encrypt_personal_data ON fleet.drivers;
DROP TRIGGER IF EXISTS trg_users_encrypt_personal_data ON auth.users;

-- Plain again (the key is needed if there are rows).
UPDATE fleet.drivers SET license_number = privacy.decrypt_text(license_number), emergency_phone = privacy.decrypt_text(emergency_phone)
    WHERE license_number LIKE 'enc:v1:%' OR emergency_phone LIKE 'enc:v1:%';
UPDATE auth.users SET phone = privacy.decrypt_text(phone) WHERE phone LIKE 'enc:v1:%';

DROP INDEX IF EXISTS fleet.ux_drivers_license_number_idx;
ALTER TABLE fleet.drivers DROP COLUMN IF EXISTS license_number_idx;
DO $$ BEGIN
    ALTER TABLE fleet.drivers ADD CONSTRAINT drivers_license_number_key UNIQUE (license_number);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
ALTER TABLE fleet.drivers ALTER COLUMN license_number TYPE VARCHAR(100);
ALTER TABLE fleet.drivers ALTER COLUMN emergency_phone TYPE VARCHAR(50);
ALTER TABLE auth.users ALTER COLUMN phone TYPE VARCHAR(50);

DROP FUNCTION IF EXISTS fleet.encrypt_driver_personal_data();
DROP FUNCTION IF EXISTS auth.encrypt_user_personal_data();
DROP SCHEMA IF EXISTS privacy CASCADE;
