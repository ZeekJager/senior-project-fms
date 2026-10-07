#!/bin/sh
# Starts a throwaway PostgreSQL 16 for a CI job on localhost:5432.
#
# The admin password comes from DB_ADMIN_PASSWORD, generated earlier in the
# job. This replaces a `services:` container, whose settings must be known
# before any step runs and so would need a password written into ci.yml.
set -eu

: "${DB_ADMIN_PASSWORD:?DB_ADMIN_PASSWORD is not set}"

docker run -d --name fms-ci-postgres -p 5432:5432 \
  -e POSTGRES_USER=fms_admin \
  -e POSTGRES_PASSWORD="${DB_ADMIN_PASSWORD}" \
  -e POSTGRES_DB=fms_db \
  postgres:16 >/dev/null

# -h localhost forces TCP, which only answers once initdb has finished.
for _ in $(seq 1 60); do
  if docker exec fms-ci-postgres pg_isready -h localhost -U fms_admin -d fms_db >/dev/null 2>&1; then
    echo "PostgreSQL is ready."
    exit 0
  fi
  sleep 1
done

echo "PostgreSQL did not become ready within 60 s." >&2
docker logs fms-ci-postgres >&2
exit 1
