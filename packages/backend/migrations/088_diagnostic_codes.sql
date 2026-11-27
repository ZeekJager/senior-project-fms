-- =====================================================================
-- 088_diagnostic_codes.sql
-- Diagnostic trouble codes from telematics (FMS-132, docs/diagnostic-codes.md).
--
-- A telematics provider's webhook (the FMS format) may carry `diagnostics`:
-- engine fault codes, OBD-II (P0217) or J1939 (SPN and FMI), active or
-- cleared. Each code a vehicle reports is one row of
-- tracking.diagnostic_codes while it is active: a repeat moves last_seen_at
-- and counts an occurrence, a clear closes it with its time. A code reported
-- again after its clear opens a new row.
--
-- tracking.diagnostic_code_dictionary names the generic codes and how severe
-- each is: OBD-II codes by code, J1939 parameters by SPN. A code it does not
-- name is kept with no description, its severity from its class.
-- =====================================================================

-- +migrate Up

DO $$ BEGIN
    CREATE TYPE tracking.diagnostic_protocol AS ENUM ('obd2', 'j1939');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tracking.diagnostic_code_dictionary (
    protocol     tracking.diagnostic_protocol NOT NULL,
    -- OBD-II: the code (P0217). J1939: the SPN (110).
    code         VARCHAR(10) NOT NULL,
    description  VARCHAR(255) NOT NULL,
    severity     VARCHAR(10) NOT NULL,
    PRIMARY KEY (protocol, code),
    CONSTRAINT chk_diagnostic_dictionary_severity CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE TABLE IF NOT EXISTS tracking.diagnostic_codes (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    vehicle_id     BIGINT NOT NULL REFERENCES fleet.vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
    provider_id    BIGINT REFERENCES integration.external_providers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    gps_device_id  BIGINT REFERENCES integration.gps_devices(id) ON DELETE SET NULL ON UPDATE CASCADE,
    protocol       tracking.diagnostic_protocol NOT NULL,
    -- OBD-II: the code. J1939: SPN-FMI (110-0).
    code           VARCHAR(20) NOT NULL,
    spn            INTEGER,
    fmi            SMALLINT,
    -- From the dictionary when it names the code; null when it does not.
    description    VARCHAR(255),
    severity       VARCHAR(10) NOT NULL,
    first_seen_at  TIMESTAMPTZ NOT NULL,
    last_seen_at   TIMESTAMPTZ NOT NULL,
    occurrences    INTEGER NOT NULL DEFAULT 1,
    cleared_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_diagnostic_codes_severity CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT chk_diagnostic_codes_occurrences CHECK (occurrences >= 1),
    CONSTRAINT chk_diagnostic_codes_seen CHECK (last_seen_at >= first_seen_at),
    CONSTRAINT chk_diagnostic_codes_cleared CHECK (cleared_at IS NULL OR cleared_at >= first_seen_at),
    CONSTRAINT chk_diagnostic_codes_j1939 CHECK ((protocol = 'j1939') = (spn IS NOT NULL AND fmi IS NOT NULL)),
    CONSTRAINT chk_diagnostic_codes_spn CHECK (spn IS NULL OR spn BETWEEN 0 AND 524287),
    CONSTRAINT chk_diagnostic_codes_fmi CHECK (fmi IS NULL OR fmi BETWEEN 0 AND 31)
);

-- One active row per vehicle and code: a repeat updates it.
CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_codes_active
    ON tracking.diagnostic_codes (vehicle_id, protocol, code) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_diagnostic_codes_vehicle
    ON tracking.diagnostic_codes (vehicle_id, last_seen_at DESC);

CREATE OR REPLACE TRIGGER trg_tracking_diagnostic_codes_updated_at
    BEFORE UPDATE ON tracking.diagnostic_codes
    FOR EACH ROW EXECUTE FUNCTION shared.set_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_app') THEN
        GRANT SELECT ON tracking.diagnostic_code_dictionary TO fms_app;
        GRANT SELECT, INSERT, UPDATE ON tracking.diagnostic_codes TO fms_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tracking TO fms_app;
    END IF;
END $$;

-- The generic codes (SAE J2012 for OBD-II, J1939-71 for the SPNs), the ones a fleet sees most.
INSERT INTO tracking.diagnostic_code_dictionary (protocol, code, description, severity) VALUES
    ('obd2', 'P0011', 'Camshaft position timing over-advanced (bank 1)', 'medium'),
    ('obd2', 'P0087', 'Fuel rail pressure too low', 'high'),
    ('obd2', 'P0101', 'Mass air flow sensor range or performance', 'medium'),
    ('obd2', 'P0113', 'Intake air temperature sensor high input', 'low'),
    ('obd2', 'P0115', 'Engine coolant temperature sensor circuit', 'medium'),
    ('obd2', 'P0117', 'Engine coolant temperature sensor low input', 'medium'),
    ('obd2', 'P0118', 'Engine coolant temperature sensor high input', 'medium'),
    ('obd2', 'P0128', 'Coolant thermostat below regulating temperature', 'low'),
    ('obd2', 'P0171', 'System too lean (bank 1)', 'medium'),
    ('obd2', 'P0172', 'System too rich (bank 1)', 'medium'),
    ('obd2', 'P0217', 'Engine overheating', 'critical'),
    ('obd2', 'P0219', 'Engine overspeed', 'high'),
    ('obd2', 'P0234', 'Turbocharger overboost', 'high'),
    ('obd2', 'P0299', 'Turbocharger underboost', 'medium'),
    ('obd2', 'P0300', 'Random or multiple cylinder misfire', 'high'),
    ('obd2', 'P0301', 'Cylinder 1 misfire', 'high'),
    ('obd2', 'P0302', 'Cylinder 2 misfire', 'high'),
    ('obd2', 'P0303', 'Cylinder 3 misfire', 'high'),
    ('obd2', 'P0304', 'Cylinder 4 misfire', 'high'),
    ('obd2', 'P0335', 'Crankshaft position sensor circuit', 'high'),
    ('obd2', 'P0380', 'Glow plug circuit', 'medium'),
    ('obd2', 'P0401', 'Exhaust gas recirculation flow insufficient', 'medium'),
    ('obd2', 'P0420', 'Catalyst efficiency below threshold (bank 1)', 'low'),
    ('obd2', 'P0442', 'Evaporative emission system small leak', 'low'),
    ('obd2', 'P0500', 'Vehicle speed sensor', 'medium'),
    ('obd2', 'P0520', 'Engine oil pressure sensor circuit', 'high'),
    ('obd2', 'P0524', 'Engine oil pressure too low', 'critical'),
    ('obd2', 'P0562', 'System voltage low', 'medium'),
    ('obd2', 'P0563', 'System voltage high', 'medium'),
    ('obd2', 'P0606', 'Engine control module processor', 'high'),
    ('obd2', 'P0700', 'Transmission control system malfunction', 'high'),
    ('obd2', 'P0715', 'Transmission input speed sensor circuit', 'medium'),
    ('obd2', 'P0730', 'Incorrect gear ratio', 'high'),
    ('obd2', 'P2002', 'Diesel particulate filter efficiency below threshold', 'medium'),
    ('obd2', 'P2263', 'Turbocharger boost system performance', 'medium'),
    ('obd2', 'C0035', 'Left front wheel speed sensor circuit', 'high'),
    ('obd2', 'C0040', 'Right front wheel speed sensor circuit', 'high'),
    ('obd2', 'C0265', 'ABS motor relay circuit', 'high'),
    ('obd2', 'B0001', 'Driver frontal airbag deployment control', 'high'),
    ('obd2', 'U0100', 'Lost communication with the engine control module', 'high'),
    ('obd2', 'U0101', 'Lost communication with the transmission control module', 'high'),
    ('obd2', 'U0121', 'Lost communication with the ABS control module', 'high'),
    ('j1939', '84', 'Wheel-based vehicle speed', 'medium'),
    ('j1939', '91', 'Accelerator pedal position', 'high'),
    ('j1939', '94', 'Fuel delivery pressure', 'high'),
    ('j1939', '96', 'Fuel level', 'low'),
    ('j1939', '97', 'Water in fuel indicator', 'medium'),
    ('j1939', '100', 'Engine oil pressure', 'critical'),
    ('j1939', '102', 'Intake manifold boost pressure', 'medium'),
    ('j1939', '105', 'Intake manifold temperature', 'medium'),
    ('j1939', '110', 'Engine coolant temperature', 'critical'),
    ('j1939', '111', 'Engine coolant level', 'high'),
    ('j1939', '157', 'Fuel rail pressure', 'high'),
    ('j1939', '168', 'Battery potential (voltage)', 'medium'),
    ('j1939', '175', 'Engine oil temperature', 'high'),
    ('j1939', '190', 'Engine speed', 'medium'),
    ('j1939', '520', 'Retarder torque', 'medium'),
    ('j1939', '597', 'Brake switch', 'high'),
    ('j1939', '3216', 'Aftertreatment NOx (intake)', 'low'),
    ('j1939', '3251', 'Diesel particulate filter differential pressure', 'medium'),
    ('j1939', '3364', 'Diesel exhaust fluid quality', 'medium')
ON CONFLICT (protocol, code) DO NOTHING;

-- +migrate Down

DROP TABLE IF EXISTS tracking.diagnostic_codes;
DROP TABLE IF EXISTS tracking.diagnostic_code_dictionary;
DROP TYPE IF EXISTS tracking.diagnostic_protocol;
