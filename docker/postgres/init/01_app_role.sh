#!/bin/sh
# Runs once, on first boot of an empty postgres_data volume, as
# POSTGRES_USER (fms_admin). Creates the app's runtime role.
#
# fms_admin owns every table (migrations run as fms_admin); fms_app is
# a non-owner, so per-table REVOKEs in migrations bind to it. Default
# privileges give fms_app CRUD on every table fms_admin creates later,
# which migrations can then narrow (e.g. audit_logs -> INSERT only).
#
# The password comes from DB_APP_PASSWORD (.env), never from this file.
# Role names are fixed: migration 013 grants to fms_app by name.
set -e

: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  -v app_password="${DB_APP_PASSWORD}" \
  -v db_name="${POSTGRES_DB}" <<'SQL'
CREATE ROLE fms_app LOGIN PASSWORD :'app_password';

GRANT CONNECT ON DATABASE :"db_name" TO fms_app;
GRANT USAGE ON SCHEMA public TO fms_app;

ALTER DEFAULT PRIVILEGES FOR ROLE fms_admin IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fms_admin IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO fms_app;
SQL
