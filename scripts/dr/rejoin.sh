#!/bin/sh
# After a failover: the old, fenced primary becomes the standby of the new one (FMS-162,
# docs/disaster-recovery.md#failover-runbook).
#
#   sh scripts/dr/rejoin.sh [--rebuild] [--servers "fms_postgres fms_postgres_replica"]
#
# In a throwaway container with the old server's data, image and settings, on the stack's network:
#   1. pg_rewind against the new primary (through db-proxy): the old timeline's changes the new primary never had are
#      undone, and what it has since is copied; WAL it needs is fetched from the backup repository. It runs the old
#      server's crash recovery first when it did not shut down cleanly;
#   2. it is made a standby: standby.signal, streaming from db-proxy with the replication login and slot, and
#      fetching from the repository whatever the primary no longer has;
#   3. the fence is removed and the server started: its entrypoint gives the new primary the slot it streams with,
#      and it streams. Waits until it does, and until db-proxy:5433 reaches it.
# --rebuild, or when pg_rewind fails: its data is replaced by a new copy of the primary instead (slower, the same end).
set -eu

REBUILD=0
SERVERS="fms_postgres fms_postgres_replica"
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1; shift ;;
    --servers) SERVERS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

STARTED=$(date +%s)
say() { echo "[$(( $(date +%s) - STARTED ))s] $*"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
sql() { docker exec -u postgres "$1" psql -X -q -At -h /var/run/postgresql -U fms_admin -d fms_db -c "$2" 2>/dev/null; }

PRIMARY=""
OLD=""
for s in $SERVERS; do
  if running "$s" && [ "$(sql "$s" 'select pg_is_in_recovery()')" = f ]; then PRIMARY="$s"; else OLD="$s"; fi
done
[ -n "$PRIMARY" ] || { echo "No running primary among: $SERVERS" >&2; exit 1; }
[ -n "$OLD" ] && [ "$OLD" != "$PRIMARY" ] || { echo "No other server to rejoin besides the primary $PRIMARY" >&2; exit 1; }
if running "$OLD"; then echo "$OLD is running; stop it first (it was fenced by promote.sh): docker stop $OLD" >&2; exit 1; fi

VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$OLD")
REPO_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/pgbackrest"}}{{.Name}}{{end}}{{end}}' "$PRIMARY")
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$OLD")
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PRIMARY")
# The old server's settings and passwords, for the throwaway container: a file only this user reads, removed on exit,
# in the current folder so docker.exe on Windows can open it too.
ENV_FILE=$(mktemp ./.rejoin-env.XXXXXX)
trap 'rm -f "$ENV_FILE"' EXIT
chmod 600 "$ENV_FILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$OLD" | grep -E '^(PG|POSTGRES_|DB_|PGBACKREST_)' > "$ENV_FILE"

say "Rejoining $OLD as the standby of $PRIMARY"
MODE=rewind
[ "$REBUILD" = 1 ] && MODE=rebuild
docker run --rm -i --entrypoint sh --network "$NETWORK" --env-file "$ENV_FILE" -e MODE="$MODE" \
  -v "$VOLUME":/var/lib/postgresql/data -v "$REPO_VOLUME":/var/lib/pgbackrest "$IMAGE" -s <<'SH'
set -eu
D=/var/lib/postgresql/data
SRC="host=db-proxy port=5432 user=fms_admin dbname=fms_db"
chown -R postgres:postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest 2>/dev/null || true
standby_settings() {
  # Streaming from the endpoint with the replication login and slot; what the primary no longer has, from the repository.
  sed -i '/^primary_conninfo/d; /^primary_slot_name/d; /^restore_command/d; /^recovery_target/d' "$D/postgresql.auto.conf" 2>/dev/null || true
  cat >> "$D/postgresql.auto.conf" <<EOF
primary_conninfo = 'host=db-proxy port=5432 user=fms_replicator password=${DB_REPLICATION_PASSWORD} application_name=fms_standby'
primary_slot_name = 'fms_replica'
restore_command = 'pgbackrest --stanza=fms archive-get %f "%p"'
EOF
  touch "$D/standby.signal"
  chown postgres:postgres "$D/postgresql.auto.conf" "$D/standby.signal"
}
if [ "$MODE" = rewind ]; then
  echo "rejoin: pg_rewind against the new primary"
  # pg_rewind needs the old server's restore_command to fetch WAL it no longer has (--restore-target-wal).
  sed -i '/^restore_command/d' "$D/postgresql.auto.conf" 2>/dev/null || true
  echo "restore_command = 'pgbackrest --stanza=fms archive-get %f \"%p\"'" >> "$D/postgresql.auto.conf"
  rm -f "$D/standby.signal"
  if gosu postgres env PGPASSWORD="$DB_ADMIN_PASSWORD" pg_rewind --target-pgdata="$D" --source-server="$SRC" --restore-target-wal --progress; then
    standby_settings
  else
    echo "rejoin: pg_rewind failed; copying the primary again instead" >&2
    MODE=rebuild
  fi
fi
if [ "$MODE" = rebuild ]; then
  echo "rejoin: replacing the data with a new copy of the primary"
  find "$D" -mindepth 1 -delete
  gosu postgres env PGPASSWORD="$DB_REPLICATION_PASSWORD" pg_basebackup -h db-proxy -U fms_replicator -D "$D" -X stream -R
  standby_settings
fi
rm -f "$D/fms.fenced"
echo "rejoin: $MODE done; the fence is removed"
SH

# What the old server is doing when it does not stream (SE-208): its container's state, what runs in it, its log.
not_streaming() {
  {
    echo "$OLD is not streaming from $PRIMARY after 3 minutes."
    echo "Its container: $(docker inspect -f 'status={{.State.Status}} exit={{.State.ExitCode}} restarting={{.State.Restarting}} restarts={{.RestartCount}} started={{.State.StartedAt}} error={{.State.Error}}' "$OLD" 2>&1)"
    echo "What runs in it:"
    docker top "$OLD" -o pid,etime,args 2>&1 || true
    echo "Its last 100 log lines:"
    docker logs --tail 100 "$OLD" 2>&1 || true
  } >&2
}

say "Starting $OLD as the standby"
docker start "$OLD" >/dev/null
OLD_IP=""
i=0
until [ -n "$OLD_IP" ] && [ "$(docker exec "$PRIMARY" sh -c "psql -X -q -At -h /var/run/postgresql -U fms_admin -d fms_db -c \"select count(*) from pg_stat_replication where state = 'streaming' and client_addr is not null\"" 2>/dev/null)" -ge 1 ] \
      && [ "$(docker exec "$PRIMARY" sh -c 'PGPASSWORD="$DB_ADMIN_PASSWORD" PGCONNECT_TIMEOUT=5 psql -X -q -At -h db-proxy -p 5433 -U fms_admin -d fms_db -c "select pg_is_in_recovery()"' 2>/dev/null)" = t ]; do
  OLD_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$OLD" 2>/dev/null || true)
  i=$((i + 1)); [ "$i" -gt 180 ] && { not_streaming; exit 1; }
  sleep 1
done
say "Done: $OLD streams from $PRIMARY, and db-proxy:5433 reaches it. $PRIMARY stays the primary."
