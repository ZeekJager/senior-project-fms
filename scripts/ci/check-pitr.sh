#!/bin/sh
# CI check of continuous archiving and point-in-time recovery (FMS-108, docs/backups.md), on the
# running Compose stack (job docker-stack):
#   1. the primary archives WAL and its first full base backup succeeded;
#   2. a row is written, the time noted, a second row written after it, and the WAL switched so both
#      are archived;
#   3. scripts/backup/pitr-restore.sh restores to the noted time into a new container;
#   4. the copy has the first row and not the second, and the live database was not touched;
#   5. the restore drill (drill.sh) restores into a scratch instance, replays to its restore point, and finds
#      the same rows and checksum as the live table had there.
set -eu

live() { docker compose exec -T postgres psql -X -At -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -c "$1"; }

echo "== Archiving is on and the first full backup succeeds"
[ "$(live 'show archive_mode')" = on ]
# This job applies no migrations, so backup.base_backups is not there: ask pgBackRest itself.
i=0
until docker compose exec -T -u postgres postgres pgbackrest --stanza=fms --output=json info 2>/dev/null | grep -q '"type":"full"'; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    echo "No full backup after 3 minutes:" >&2
    docker compose exec -T postgres sh -c 'tail -n 30 /var/log/pgbackrest/*.log' >&2 || true
    exit 1
  fi
  sleep 2
done

echo "== A row before the target time, one after it"
live "create table if not exists public.pitr_check (marker text primary key, written_at timestamptz default clock_timestamp())" >/dev/null
live "insert into public.pitr_check (marker) values ('before') on conflict do nothing" >/dev/null
sleep 2
TARGET=$(live "select clock_timestamp()::text")
sleep 2
live "insert into public.pitr_check (marker) values ('after') on conflict do nothing" >/dev/null
# Close the current WAL segment so both rows reach the archive now instead of within archive_timeout.
SEGMENT=$(live "select pg_walfile_name(pg_switch_wal())")
i=0
until [ "$(live "select coalesce(last_archived_wal >= '$SEGMENT', false) from pg_stat_archiver")" = t ]; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "WAL segment $SEGMENT was not archived in 2 minutes" >&2; live "select * from pg_stat_archiver" >&2; exit 1; }
  sleep 2
done

echo "== Restoring to $TARGET"
sh scripts/backup/pitr-restore.sh --to "$TARGET" --name ci

copy() { docker exec fms_pitr_ci psql -X -At -U fms_admin -d fms_db -c "$1"; }
cleanup() { docker rm -f fms_pitr_ci >/dev/null 2>&1 || true; docker volume rm fms_pitr_ci_data >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ "$(copy "select count(*) from public.pitr_check where marker = 'before'")" = 1 ] || { echo "The restored copy lacks the row written before the target" >&2; exit 1; }
[ "$(copy "select count(*) from public.pitr_check where marker = 'after'")" = 0 ] || { echo "The restored copy has the row written after the target" >&2; exit 1; }
[ "$(live "select count(*) from public.pitr_check")" = 2 ] || { echo "The live database changed" >&2; exit 1; }
live "drop table public.pitr_check" >/dev/null
echo "Point-in-time restore passed: the copy stops at $TARGET."

echo "== The restore drill: the WAL replayed to a restore point, the same rows and checksum"
# This job applies no migrations: the drill compares a table of its own and only prints its result.
live "create table public.drill_check (id int primary key, v text)" >/dev/null
live "insert into public.drill_check select g, md5(g::text) from generate_series(1, 5000) g" >/dev/null
docker compose exec -T -u postgres -e DRILL_TABLES=public.drill_check postgres /usr/local/bin/fms-pgbackrest/drill.sh manual
live "drop table public.drill_check" >/dev/null
docker compose exec -T postgres sh -c '[ ! -e /var/lib/postgresql/drill ]' || { echo "The drill left its scratch directory behind" >&2; exit 1; }
