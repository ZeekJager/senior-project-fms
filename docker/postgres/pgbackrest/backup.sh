#!/bin/sh
# Takes one pgBackRest base backup and records it in backup.base_backups (FMS-108, docs/backups.md).
#
#   backup.sh full|diff [schedule|first-start|manual]
#
# Runs as the postgres user inside the database container: pgBackRest reads the data directory
# directly. The row is written over the local socket (trusted there, docker/postgres/pg_hba.conf):
# running first, then succeeded with what pgBackRest reports (label, sizes, WAL range), or failed with
# the last lines of its log. Backups pgBackRest has expired by retention are marked expired, so the
# Backups screen keeps the history and shows only what can still be restored.
set -u

TYPE="${1:?usage: backup.sh full|diff [schedule|first-start|manual]}"
TRIGGER="${2:-manual}"
case "$TYPE" in full|diff) ;; *) echo "backup.sh: type must be full or diff" >&2; exit 2 ;; esac
case "$TRIGGER" in schedule|first-start|manual) ;; *) echo "backup.sh: trigger must be schedule, first-start or manual" >&2; exit 2 ;; esac

DB="${POSTGRES_DB:-fms_db}"
DBUSER="${POSTGRES_USER:-fms_admin}"
sql() { psql -X -q -At -U "$DBUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
# psql substitutes :'name' variables only in SQL it reads, not in -c: statements with values go on stdin.
sqlv() { sql "$@" -f -; }

# Before migration 075 has run, back up all the same, without recording.
RECORD=0
[ "$(sql -c "select to_regclass('backup.base_backups') is not null")" = t ] && RECORD=1

ROW=""
if [ "$RECORD" = 1 ]; then
  ROW=$(echo "insert into backup.base_backups (backup_type, triggered_by) values (:'type', :'trig') returning id" \
    | sqlv -v type="$TYPE" -v trig="$TRIGGER")
fi

LOG=$(mktemp)
if pgbackrest --stanza=fms --type="$TYPE" backup >"$LOG" 2>&1; then
  rm -f "$LOG"
  if [ "$RECORD" = 1 ]; then
    INFO=$(pgbackrest --stanza=fms --output=json info)
    # The newest backup in the repository is the one just taken.
    sqlv -v id="$ROW" -v info="$INFO" <<'SQL'
      with last as (select b from jsonb_array_elements((:'info')::jsonb -> 0 -> 'backup') b
                     order by (b -> 'timestamp' ->> 'stop')::bigint desc limit 1)
      update backup.base_backups set
             status = 'succeeded',
             label = b ->> 'label',
             backup_type = b ->> 'type',
             finished_at = clock_timestamp(),
             size_bytes = (b -> 'info' ->> 'size')::bigint,
             repo_size_bytes = (b -> 'info' -> 'repository' ->> 'delta')::bigint,
             wal_start = b -> 'archive' ->> 'start',
             wal_stop = b -> 'archive' ->> 'stop'
        from last where id = :id;
SQL
    sqlv -v info="$INFO" <<'SQL'
      update backup.base_backups set status = 'expired'
       where status = 'succeeded'
         and label not in (select b ->> 'label' from jsonb_array_elements((:'info')::jsonb -> 0 -> 'backup') b);
SQL
  fi
  echo "pgbackrest: $TYPE backup succeeded ($TRIGGER)"
  exit 0
fi

ERR=$(tail -n 5 "$LOG")
rm -f "$LOG"
if [ "$RECORD" = 1 ]; then
  echo "update backup.base_backups set status = 'failed', finished_at = clock_timestamp(), error = :'err' where id = :id" \
    | sqlv -v id="$ROW" -v err="$ERR"
fi
echo "pgbackrest: $TYPE backup FAILED ($TRIGGER): $ERR" >&2
exit 1
