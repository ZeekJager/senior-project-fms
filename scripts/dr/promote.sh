#!/bin/sh
# Failover: the standby becomes the primary (FMS-162, docs/disaster-recovery.md#failover-runbook).
#
#   sh scripts/dr/promote.sh [--yes] [--servers "fms_postgres fms_postgres_replica"]
#
# One person decides; this script acts. It:
#   1. finds which server is the standby, and says how far behind the primary it is (what a failover loses);
#   2. fences the old primary: writes fms.fenced into its data directory (its role agent then says "down" at once,
#      so the endpoint sends it nothing) and stops it; a fenced server refuses to start until rejoin.sh;
#   3. promotes the standby (pg_ctl promote);
#   4. waits until the stable endpoint (db-proxy:5432) reaches the new primary and a write succeeds there, and until
#      the API's /health/ready says its database is ok again;
#   5. starts a full base backup on the new primary, in the background (its timeline is new).
# Then make the old primary the standby: sh scripts/dr/rejoin.sh.
#
# --yes skips the question (CI, the game day). Needs the docker CLI on the machine that runs the stack.
set -eu

YES=0
SERVERS="fms_postgres fms_postgres_replica"
API="fms_backend"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --servers) SERVERS="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

STARTED=$(date +%s)
say() { echo "[$(( $(date +%s) - STARTED ))s] $*"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
sql() { docker exec -u postgres "$1" psql -X -q -At -h /var/run/postgresql -U fms_admin -d fms_db -c "$2" 2>/dev/null; }
role() { running "$1" && sql "$1" 'select pg_is_in_recovery()' || true; }

STANDBY=""
OLD=""
for s in $SERVERS; do
  case "$(role "$s")" in
    t) STANDBY="$s" ;;
    *) OLD="${OLD:+$OLD }$s" ;;
  esac
done
[ -n "$STANDBY" ] || { echo "No running standby among: $SERVERS. Restore from the backups instead (docs/disaster-recovery.md)." >&2; exit 1; }
set -- $OLD
[ $# -eq 1 ] || { echo "Expected one other server besides the standby $STANDBY, found: ${OLD:-none}" >&2; exit 1; }
OLD="$1"

LAG=$(sql "$STANDBY" "select coalesce(round(extract(epoch from now() - pg_last_xact_replay_timestamp()))::text, 'unknown') || ' s since the last change replayed, ' || pg_size_pretty(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())) || ' received and not replayed yet'")
say "The standby is $STANDBY ($LAG)."
if running "$OLD"; then
  say "The primary is $OLD, still running: it will be fenced and stopped."
else
  say "The primary $OLD is not running."
fi
if [ "$YES" != 1 ]; then
  printf "Promote %s to primary? Changes the standby has not received are lost. [yes/no] " "$STANDBY"
  read -r answer
  [ "$answer" = yes ] || { echo "Nothing changed."; exit 1; }
fi

say "1/5 Fencing $OLD"
VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$OLD" 2>/dev/null || true)
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$STANDBY")
FENCE="fenced by scripts/dr/promote.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ); $STANDBY is the primary"
if running "$OLD"; then
  # The fence first: its role agent says "down" at once, so the endpoint stops sending it sessions before it stops.
  docker exec "$OLD" sh -c "echo '$FENCE' > \"\$PGDATA/fms.fenced\""
  docker stop -t 30 "$OLD" >/dev/null
elif [ -n "$VOLUME" ]; then
  docker run --rm --entrypoint sh -v "$VOLUME":/var/lib/postgresql/data "$IMAGE" -c "echo '$FENCE' > /var/lib/postgresql/data/fms.fenced"
else
  echo "Cannot reach $OLD or its data to fence it. Make sure it cannot come back as a primary (power it off, cut its network) before going on." >&2
  [ "$YES" = 1 ] || exit 1
fi

say "2/5 Promoting $STANDBY"
docker exec -u postgres "$STANDBY" sh -c 'pg_ctl promote -D "$PGDATA" -w -t 120' >/dev/null

say "3/5 Waiting for the endpoint to reach the new primary"
TARGET=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$STANDBY" | cut -d' ' -f1)
# Through the endpoint: which server answered, whether it is a standby, and a transaction id (a write).
through_endpoint() {
  docker exec "$STANDBY" sh -c 'PGPASSWORD="$DB_ADMIN_PASSWORD" PGCONNECT_TIMEOUT=5 psql -X -q -At -F: -h db-proxy -p 5432 -U fms_admin -d fms_db \
    -c "select host(inet_server_addr()), pg_is_in_recovery(), txid_current() > 0"' 2>/dev/null || true
}
i=0
until [ "$(through_endpoint)" = "$TARGET:f:t" ]; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "The endpoint did not reach $STANDBY as a writable primary in 60 s" >&2; exit 1; }
  sleep 1
done
say "    db-proxy:5432 is $STANDBY, and takes writes"

say "4/5 Waiting for the API"
if running "$API"; then
  i=0
  until docker exec "$API" sh -c 'wget -qO- http://127.0.0.1:3000/health/ready 2>/dev/null || true' | grep -q '"database":"ok"'; do
    i=$((i + 1)); [ "$i" -gt 90 ] && { echo "The API's database check is not ok 90 s after the promotion" >&2; exit 1; }
    sleep 1
  done
  say "    the API's database is ok"
else
  say "    no API container $API here: skipped"
fi

say "5/5 A full base backup of the new primary, in the background"
# A promoted server records its new timeline in pg_control at its next checkpoint, and pgBackRest refuses a backup
# until then ("WAL timeline does not match pg_control timeline"): checkpoint first.
docker exec -d -u postgres "$STANDBY" sh -c 'psql -X -q -h /var/run/postgresql -U fms_admin -d fms_db -c checkpoint && /usr/local/bin/fms-pgbackrest/backup.sh full manual'

say "Failover done in $(( $(date +%s) - STARTED )) s: $STANDBY is the primary. Next: sh scripts/dr/rejoin.sh, to make $OLD the standby."
