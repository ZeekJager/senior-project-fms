-- Runs once, on first boot of an empty postgres_data volume, as
-- POSTGRES_USER (fms_admin). Creates the app's runtime role.
--
-- fms_admin owns every table (migrations run as fms_admin); fms_app is
-- a non-owner, so per-table REVOKEs in migrations bind to it. Default
-- privileges give fms_app CRUD on every table fms_admin creates later,
-- which migrations can then narrow (e.g. audit_logs -> INSERT only).

CREATE ROLE fms_app LOGIN PASSWORD 'apppassword';

GRANT CONNECT ON DATABASE fms_db TO fms_app;
GRANT USAGE ON SCHEMA public TO fms_app;

ALTER DEFAULT PRIVILEGES FOR ROLE fms_admin IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fms_admin IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO fms_app;
