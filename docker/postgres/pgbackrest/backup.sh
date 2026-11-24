#!/bin/sh
# Takes a pgBackRest base backup and records it in backup.base_backups (FMS-108, docs/backups.md).
#
#   backup.sh full|diff [schedule|first-start|manual] [repo]
#
# pgBackRest backs up to one repository at a time: without [repo], one backup to each repository configured
# (1 beside the database, 2 off site with docker/postgres/offsite.env), one after another; exits 1 when any failed.
#
# Runs as the postgres user inside the database container: pgBackRest reads the data directory
# directly. The row is written over the local socket (trusted there, docker/postgres/pg_hba.conf):
# running first, then succeeded with what pgBackRest reports (label, sizes, WAL range), or failed with
# the last lines of its log. Backups pgBackRest has expired by retention are marked expired, so the
# Backups screen keeps the history and shows only what can still be restored.
set -u

TYPE="${1:?usage: backup.sh full|diff [schedule|first-start|manual] [repo]}"
TRIGGER="${2:-manual}"
ONLY_REPO="${3:-}"
case "$TYPE" in full|diff) ;; *) echo "backup.sh: type must be full or diff" >&2; exit 2 ;; esac
case "$TRIGGER" in schedule|first-start|manual) ;; *) echo "backup.sh: trigger must be schedule, first-start or manual" >&2; exit 2 ;; esac
case "$ONLY_REPO" in ""|[1-4]) ;; *) echo "backup.sh: repo must be 1 to 4" >&2; exit 2 ;; esac

DB="${POSTGRES_DB:-fms_db}"
DBUSER="${POSTGRES_USER:-fms_admin}"
sql() { psql -X -q -At -U "$DBUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
# psql substitutes :'name' variables only in SQL it reads, not in -c: statements with values go on stdin.
sqlv() { sql "$@" -f -; }

# Before migration 075 has run, back up all the same, without recording; before 076, without the repository.
RECORD=0
[ "$(sql -c "select to_regclass('backup.base_backups') is not null")" = t ] && RECORD=1
HAS_REPO_KEY=0
[ "$RECORD" = 1 ] && [ "$(sql -c "select count(*) from information_schema.columns where table_schema = 'backup' and table_name = 'base_backups' and column_name = 'repo_key'")" = 1 ] && HAS_REPO_KEY=1

# The repositories configured, as pgBackRest numbers them ("key" in its info; "repo-key" elsewhere does not match).
repo_keys() { pgbackrest --stanza=fms --output=json info 2>/dev/null | grep -o '"key":[0-9]*' | cut -d: -f2 | sort -un; }

one() {
  repo="$1"
  ROW=""
  if [ "$RECORD" = 1 ]; then
    if [ "$HAS_REPO_KEY" = 1 ]; then
      ROW=$(echo "insert into backup.base_backups (backup_type, triggered_by, repo_key) values (:'type', :'trig', :'repo') returning id" \
        | sqlv -v type="$TYPE" -v trig="$TRIGGER" -v repo="$repo")
    else
      ROW=$(echo "insert into backup.base_backups (backup_type, triggered_by) values (:'type', :'trig') returning id" \
        | sqlv -v type="$TYPE" -v trig="$TRIGGER")
    fi
  fi

  LOG=$(mktemp)
  if pgbackrest --stanza=fms --repo="$repo" --type="$TYPE" backup >"$LOG" 2>&1; then
    rm -f "$LOG"
    if [ "$RECORD" = 1 ]; then
      INFO=$(pgbackrest --stanza=fms --repo="$repo" --output=json info)
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
      # Expired in this repository: no longer in its list.
      if [ "$HAS_REPO_KEY" = 1 ]; then
        sqlv -v info="$INFO" -v repo="$repo" <<'SQL'
          update backup.base_backups set status = 'expired'
           where status = 'succeeded' and repo_key = (:'repo')::smallint
             and label not in (select b ->> 'label' from jsonb_array_elements((:'info')::jsonb -> 0 -> 'backup') b);
SQL
      else
        sqlv -v info="$INFO" <<'SQL'
          update backup.base_backups set status = 'expired'
           where status = 'succeeded'
             and label not in (select b ->> 'label' from jsonb_array_elements((:'info')::jsonb -> 0 -> 'backup') b);
SQL
      fi
    fi
    echo "pgbackrest: $TYPE backup to repo $repo succeeded ($TRIGGER)"
    return 0
  fi

  ERR=$(tail -n 5 "$LOG")
  rm -f "$LOG"
  if [ "$RECORD" = 1 ]; then
    echo "update backup.base_backups set status = 'failed', finished_at = clock_timestamp(), error = :'err' where id = :id" \
      | sqlv -v id="$ROW" -v err="$ERR"
  fi
  echo "pgbackrest: $TYPE backup to repo $repo FAILED ($TRIGGER): $ERR" >&2
  return 1
}

REPOS="$ONLY_REPO"
[ -n "$REPOS" ] || REPOS=$(repo_keys)
[ -n "$REPOS" ] || REPOS=1
STATUS=0
for r in $REPOS; do one "$r" || STATUS=1; done
exit "$STATUS"
