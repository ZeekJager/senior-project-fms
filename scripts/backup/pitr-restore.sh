#!/bin/sh
# Point-in-time restore of the FMS database (FMS-108, docs/backups.md#point-in-time-restore-runbook).
#
#   sh scripts/backup/pitr-restore.sh --to "2026-11-24 10:15:00+03" [--name <name>] [--stack <container>]
#
# Restores the latest base backup taken before --to, replays the archived WAL up to that second, and
# starts the result as a separate database container, fms_pitr_<name>, on the stack's network and
# published nowhere. The live database is never written: the restore goes into a new volume,
# fms_pitr_<name>_data. Check it there, then follow the runbook to switch over, or remove it:
#   docker rm -f fms_pitr_<name> && docker volume rm fms_pitr_<name>_data
#
# --to takes any timestamp PostgreSQL reads; give the time zone. --name defaults to the time of the run.
# Needs the docker CLI and the running primary container (default fms_postgres), whose image, backup
# repository volume and passphrase it reuses.
set -eu

TO=""
NAME="$(date -u +%Y%m%d%H%M%S)"
STACK="fms_postgres"
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --stack) STACK="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TO" ] || { echo "usage: pitr-restore.sh --to \"<timestamp with time zone>\" [--name <name>]" >&2; exit 2; }
case "$NAME" in *[!a-z0-9_-]*) echo "--name: lower-case letters, digits, - and _ only" >&2; exit 2 ;; esac

CONTAINER="fms_pitr_${NAME}"
VOLUME="${CONTAINER}_data"
IMAGE=$(docker inspect -f '{{.Image}}' "$STACK")
REPO=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/pgbackrest"}}{{.Name}}{{end}}{{end}}' "$STACK")
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$STACK")
CIPHER=$(docker exec "$STACK" printenv PGBACKREST_REPO1_CIPHER_PASS)
[ -n "$REPO" ] || { echo "$STACK has no backup repository volume at /var/lib/pgbackrest" >&2; exit 1; }
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "$VOLUME already exists: choose another --name, or remove it first" >&2; exit 1
fi

echo "== Restoring to $TO into $VOLUME"
docker volume create "$VOLUME" >/dev/null
# --type=time stops replay at the target; target-action=promote opens the restored database for writes.
# The repository is mounted read-only: a restore never changes it.
docker run --rm --entrypoint sh \
  -e PGBACKREST_REPO1_CIPHER_PASS="$CIPHER" \
  -v "$REPO":/var/lib/pgbackrest:ro \
  -v "$VOLUME":/var/lib/postgresql/data \
  "$IMAGE" -c "chown postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data && \
    gosu postgres pgbackrest --stanza=fms --log-path=/tmp --lock-path=/tmp --spool-path=/tmp \
      --type=time --target=\"$TO\" --target-action=promote restore"

echo "== Starting $CONTAINER (on $NETWORK, not published)"
# The image's plain entry point: no archiving and no backup schedule, so the copy never writes to the
# live repository. Archiving starts only on the database that is switched to, as the runbook says.
# Recovery fetches the WAL it replays from the repository (the restore_command pgBackRest wrote), so
# the repository is mounted here too, read-only, with its passphrase.
docker run -d --name "$CONTAINER" --network "$NETWORK" --entrypoint docker-entrypoint.sh \
  -e PGBACKREST_REPO1_CIPHER_PASS="$CIPHER" \
  -v "$REPO":/var/lib/pgbackrest:ro \
  -v "$VOLUME":/var/lib/postgresql/data "$IMAGE" postgres -c archive_mode=off >/dev/null

i=0
until docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 && \
      [ "$(docker exec "$CONTAINER" psql -X -At -U fms_admin -d fms_db -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ]; do
  i=$((i + 1))
  if [ "$i" -gt 180 ]; then
    echo "The restored database did not open in 6 minutes. Its log:" >&2
    docker logs --tail 40 "$CONTAINER" >&2
    exit 1
  fi
  sleep 2
done

echo "== Restored. Last change replayed:"
docker exec "$CONTAINER" psql -X -At -U fms_admin -d fms_db -c "select 'recovered to ' || coalesce(pg_last_xact_replay_timestamp()::text, 'the backup itself (no later transaction before the target)')"
echo
echo "Look around:   docker exec -it $CONTAINER psql -U fms_admin -d fms_db"
echo "Switch to it:  docs/backups.md, 'Point-in-time restore (runbook)', step 4"
echo "Remove it:     docker rm -f $CONTAINER && docker volume rm $VOLUME"
