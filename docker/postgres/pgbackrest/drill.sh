#!/bin/sh
# Point-in-time restore drill of the primary database (FMS-108, docs/backups.md#restore-drills). Runs as the
# postgres user, in the database container: monthly from scheduler.sh, or by hand:
#
#   docker compose exec -u postgres postgres /usr/local/bin/fms-pgbackrest/drill.sh
#
#   1. On the live database, in one snapshot: a named restore point, and the rows and a checksum of each key
#      table (DRILL_TABLES). The WAL is switched so the restore point reaches the repository.
#   2. The latest base backup is restored into a scratch directory (DRILL_PATH) and the archived WAL replayed
#      up to the restore point, by a second PostgreSQL in this container on DRILL_PORT, reachable only through
#      its own socket. Nothing is written to the live database's files or to the repository.
#   3. Once it opens: every key table must have the same rows and checksum as the live one had at the restore
#      point. The time from the start of the restore to the database opening is the drill's RTO.
#   4. The scratch instance is stopped and removed, and the drill recorded in backup.restore_drills
#      (method pitr), which the Backups screen, System health and the alerts read.
#
# The restore needs as much free disk as the database takes. Exits 1 when the drill failed (it is recorded).
set -u

TRIGGER="${1:-manual}"
case "$TRIGGER" in schedule|manual) ;; *) echo "usage: drill.sh [schedule|manual]" >&2; exit 2 ;; esac

DB="${POSTGRES_DB:-postgres}"
DBUSER="${POSTGRES_USER:-postgres}"
DIR="${DRILL_PATH:-/var/lib/postgresql/drill}"
PORT="${DRILL_PORT:-5499}"
SOCK=/tmp/fms-drill
LOG=/var/log/pgbackrest/drill-postgres.log
# Tables written rarely enough that the live snapshot and the restore point agree; each needs an id column.
TABLES="${DRILL_TABLES:-auth.users auth.roles fleet.depots fleet.vehicles fleet.drivers trip.trips fuel.fuel_logs maintenance.maintenance_records}"
# The restore must open within this long; it is also the RTO the drill holds the database to (2 h).
MAX_SECONDS="${DRILL_MAX_SECONDS:-7200}"

live() { psql -X -q -At -U "$DBUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
copy() { psql -X -q -At -h "$SOCK" -p "$PORT" -U "$DBUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

STARTED=$(date -u +%s)
POINT="fms-drill-$(date -u +%Y%m%dT%H%M%SZ)"
LABEL=""
ERROR=""
LIVE_SUMS=""
COPY_SUMS=""
TABLES_RESTORED=""
RTO=""

stop_scratch() {
  if [ -f "$DIR/postmaster.pid" ]; then pg_ctl -D "$DIR" -m immediate -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$DIR" "$SOCK"
}
trap stop_scratch EXIT

fail() { ERROR="$1"; echo "drill: $1" >&2; }

# One query that gives "table|rows|md5" per key table that exists here.
checksum_sql() {
  first=1
  for t in $TABLES; do
    [ "$first" = 1 ] || printf ' union all '
    first=0
    printf "select '%s' || '|' || count(*) || '|' || md5(coalesce(string_agg(x::text, E'\\\\n' order by x.id), '')) from %s x" "$t" "$t"
  done
}

existing=""
for t in $TABLES; do
  [ "$(live -c "select to_regclass('$t') is not null")" = t ] && existing="$existing $t"
done
TABLES="$existing"

run() {
  [ -n "$TABLES" ] || { fail "none of the key tables exists"; return; }
  # Backups are listed oldest first: the last label is the newest, which the restore uses.
  LABEL=$(pgbackrest --stanza=fms --output=json info 2>/dev/null | grep -o '"label":"[^"]*"' | tail -1 | cut -d'"' -f4)
  [ -n "$LABEL" ] || { fail "the repository holds no base backup"; return; }

  echo "drill: restore point $POINT, then the key tables' checksums in the same snapshot"
  # The snapshot is taken by the first statement: commits after the restore point are not in it.
  LIVE_SUMS=$(live -f - <<SQL
begin isolation level repeatable read;
select pg_create_restore_point('$POINT') is not null as created \gset
$(checksum_sql);
commit;
SQL
) || { fail "the live checksums failed"; return; }
  segment=$(live -c "select pg_walfile_name(pg_switch_wal())")
  i=0
  until [ "$(live -c "select coalesce(last_archived_wal >= '$segment', false) from pg_stat_archiver")" = t ]; do
    i=$((i + 1))
    [ "$i" -gt 150 ] && { fail "WAL segment $segment was not archived in 5 minutes"; return; }
    sleep 2
  done

  echo "drill: restoring $LABEL into $DIR, replaying to $POINT"
  rm -rf "$DIR" && install -d -m 700 "$DIR" "$SOCK"
  RESTORE_STARTED=$(date -u +%s)
  if ! pgbackrest --stanza=fms --pg1-path="$DIR" --lock-path=/tmp/fms-drill-lock --log-level-console=warn \
         --type=name --target="$POINT" --target-action=promote --archive-mode=off restore; then
    fail "pgbackrest restore failed (see /var/log/pgbackrest)"; return
  fi
  # hot_standby off: nobody connects before the restore point is reached and the copy is promoted.
  pg_ctl -D "$DIR" -l "$LOG" -o "-p $PORT -c listen_addresses= -c unix_socket_directories=$SOCK -c hot_standby=off -c archive_mode=off -c max_wal_senders=0 -c shared_preload_libraries=" start >/dev/null \
    || { fail "the scratch instance did not start (see $LOG)"; return; }
  until [ "$(copy -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ]; do
    if [ $(( $(date -u +%s) - RESTORE_STARTED )) -gt "$MAX_SECONDS" ]; then
      fail "the restored database did not open within $MAX_SECONDS s"; return
    fi
    if ! pg_ctl -D "$DIR" status >/dev/null 2>&1; then
      fail "the scratch instance stopped during recovery: $(tail -n 3 "$LOG" | tr '\n' ' ')"; return
    fi
    sleep 2
  done
  RTO=$(( $(date -u +%s) - RESTORE_STARTED ))
  echo "drill: opened after $RTO s; comparing the key tables"

  COPY_SUMS=$(copy -c "$(checksum_sql)") || { fail "the restored checksums failed"; return; }
  TABLES_RESTORED=$(copy -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'")
  if [ "$LIVE_SUMS" != "$COPY_SUMS" ]; then
    fail "the restored key tables differ from the live ones at the restore point"
  fi
}

run
FINISHED_STATUS=succeeded
[ -n "$ERROR" ] && FINISHED_STATUS=failed

# Recorded once migration 076 is applied (a stack with no migrations, as in CI, only prints the result).
if [ "$(live -c "select count(*) from information_schema.columns where table_schema = 'backup' and table_name = 'restore_drills' and column_name = 'method'")" = 1 ]; then
  # Per table: the live and the restored rows and checksums, and whether they match.
  live -v label="$LABEL" -v point="$POINT" -v status="$FINISHED_STATUS" -v started="$STARTED" -v tables="$TABLES_RESTORED" \
     -v rto="$RTO" -v error="$ERROR" -v by="$TRIGGER" -v live="$LIVE_SUMS" -v copy="$COPY_SUMS" -f - <<'SQL'
with l as (
  select split_part(x, '|', 1) as t, split_part(x, '|', 2)::bigint as n, split_part(x, '|', 3) as h
    from regexp_split_to_table(:'live', E'\n') x where x <> ''),
c as (
  select split_part(x, '|', 1) as t, split_part(x, '|', 2)::bigint as n, split_part(x, '|', 3) as h
    from regexp_split_to_table(:'copy', E'\n') x where x <> ''),
checks as (
  select coalesce(jsonb_agg(jsonb_build_object('table', l.t, 'live_rows', l.n, 'restored_rows', c.n,
                                               'match', c.h is not distinct from l.h) order by l.t), '[]') as j
    from l left join c on c.t = l.t)
insert into backup.restore_drills
       (method, base_backup_label, recovery_target, target_database, status, started_at, finished_at,
        tables_restored, rto_seconds, checks, error, run_by)
select 'pitr', coalesce(nullif(:'label', ''), 'none'), :'point', 'scratch instance in the database container',
       :'status', to_timestamp(:'started'::bigint), clock_timestamp(),
       nullif(:'tables', '')::int, nullif(:'rto', '')::int, checks.j, nullif(:'error', ''),
       case :'by' when 'schedule' then 'monthly drill' else 'drill run by hand' end
  from checks;
SQL
else
  echo "drill: not recorded: backup.restore_drills has no method column yet (migration 076)"
fi

if [ -n "$ERROR" ]; then exit 1; fi
echo "drill: passed: $LABEL replayed to $POINT, opened in $RTO s, the key tables match"
