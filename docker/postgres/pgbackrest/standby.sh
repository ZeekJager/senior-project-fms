#!/bin/sh
# A streaming standby of the primary (FMS-94, FMS-162; docs/read-replica.md, docs/disaster-recovery.md). Run by
# entrypoint.sh as root, before PostgreSQL starts, in a container that is to be the standby.
#
# Every start, as the primary's owner (fms_admin), through the stable endpoint (PRIMARY_HOST, default db-proxy, so
# whichever server is the primary now):
#   - the replication role fms_replicator exists with DB_REPLICATION_PASSWORD;
#   - the physical slot fms_replica exists, so the primary keeps the WAL the standby has not received yet (bounded
#     by max_slot_wal_keep_size). A promoted standby has no slots (they are not copied), so this also gives the new
#     primary the slot for the old one rejoining.
# An empty volume: copies the primary with pg_basebackup, which writes standby.signal and primary_conninfo (-R),
# pointing at the endpoint, so the standby follows whichever server is the primary.
#
# Passwords come from the environment (.env), never from this file.
set -eu

: "${DB_ADMIN_PASSWORD:?DB_ADMIN_PASSWORD is not set}"
: "${DB_REPLICATION_PASSWORD:?DB_REPLICATION_PASSWORD is not set}"
PRIMARY_HOST="${PRIMARY_HOST:-db-proxy}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

# The primary may still be starting (or the endpoint finding it): wait up to 2 minutes.
i=0
until PGPASSWORD="$DB_ADMIN_PASSWORD" psql -X -q -h "$PRIMARY_HOST" -U fms_admin -d fms_db -Atc 'select not pg_is_in_recovery()' 2>/dev/null | grep -q t; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "standby: no primary at $PRIMARY_HOST after 2 minutes" >&2; exit 1; }
  sleep 2
done

PGPASSWORD="$DB_ADMIN_PASSWORD" psql -X -h "$PRIMARY_HOST" -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -q \
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
  echo "standby: copying the primary (through $PRIMARY_HOST) into an empty volume"
  gosu postgres env PGPASSWORD="$DB_REPLICATION_PASSWORD" \
    pg_basebackup -h "$PRIMARY_HOST" -U fms_replicator -D "$PGDATA" -X stream -S fms_replica -R
fi

# A standby copied before the stable endpoint streams from the primary by name: point it at the endpoint, so it
# follows whichever server is the primary.
AUTO="$PGDATA/postgresql.auto.conf"
if [ -f "$AUTO" ] && grep -q "^primary_conninfo" "$AUTO" && ! grep -Eq "^primary_conninfo.*host=('')?$PRIMARY_HOST('')?[ ']" "$AUTO"; then
  # pg_basebackup -R quotes each value inside the setting's quotes (host=''postgres''); older copies may not.
  sed -Ei "/^primary_conninfo/s/host=('')?[^ ']*('')?/host=''$PRIMARY_HOST''/" "$AUTO"
  echo "standby: now streams through $PRIMARY_HOST"
fi
