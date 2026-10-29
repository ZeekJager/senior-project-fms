#!/bin/sh
# The read replica (FMS-94): a streaming hot standby of the primary.
#
# Every start, as the primary's owner (fms_admin):
#   - the replication role fms_replicator exists with DB_REPLICATION_PASSWORD;
#   - the physical slot fms_replica exists, so the primary keeps the WAL the
#     replica has not received yet (bounded by max_slot_wal_keep_size).
# Done here rather than in docker/postgres/init, which runs only on a new
# primary volume: this also works on a volume created before the replica.
#
# First start (empty volume): copies the primary with pg_basebackup, which
# writes standby.signal and primary_conninfo (-R). Later starts resume
# streaming from where the replica stopped. To start over, remove the
# replica's volume: docker compose rm -sf postgres-replica &&
# docker volume rm <project>_postgres_replica_data.
#
# Passwords come from the environment (.env), never from this file.
set -eu

: "${DB_ADMIN_PASSWORD:?DB_ADMIN_PASSWORD is not set}"
: "${DB_REPLICATION_PASSWORD:?DB_REPLICATION_PASSWORD is not set}"
PRIMARY_HOST="${PRIMARY_HOST:-postgres}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export PGDATA

PGPASSWORD="$DB_ADMIN_PASSWORD" psql -h "$PRIMARY_HOST" -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -q \
  -v password="$DB_REPLICATION_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE fms_replicator WITH REPLICATION LOGIN PASSWORD %L', :'password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fms_replicator') \gexec
SELECT format('ALTER ROLE fms_replicator WITH REPLICATION LOGIN PASSWORD %L', :'password') \gexec
SELECT pg_create_physical_replication_slot('fms_replica')
 WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'fms_replica');
SQL

mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "replica: copying the primary ($PRIMARY_HOST) into an empty volume"
  gosu postgres env PGPASSWORD="$DB_REPLICATION_PASSWORD" \
    pg_basebackup -h "$PRIMARY_HOST" -U fms_replicator -D "$PGDATA" -X stream -S fms_replica -R
fi

# The same client rules as the primary (docker/postgres/pg_hba.conf). Read-only:
# a standby refuses every write, whoever connects.
exec gosu postgres postgres -c hba_file=/etc/fms/pg_hba.conf -c hot_standby=on -c hot_standby_feedback=on
