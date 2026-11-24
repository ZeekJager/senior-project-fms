#!/bin/sh
# Repository status of the primary database's backups (FMS-108, docs/backups.md). Runs as the postgres
# user, started by entrypoint.sh once the server is up.
#
# Every STATUS_INTERVAL_SECONDS (60), `pgbackrest info` for every repository (1 on this server, 2 off site
# when configured), written to backup.pitr_repositories: its status, the archived WAL range, when the newest
# segment arrived, and its base backups. The API reads that for the Backups screen ("Recoverable from ...
# to ..."), System health and the backup alerts: it cannot run pgBackRest itself. Waits while the table is
# not there (migration 076 not applied yet).
set -u

DB="${POSTGRES_DB:-postgres}"
DBUSER="${POSTGRES_USER:-postgres}"
EVERY="${STATUS_INTERVAL_SECONDS:-60}"

sql() { psql -X -q -At -U "$DBUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

record() {
  [ "$(sql -c "select to_regclass('backup.pitr_repositories') is not null")" = t ] || return 0
  # A repository that cannot be reached is still in the output, with its own status code and message.
  info=$(pgbackrest --stanza=fms --output=json info 2>/dev/null)
  if [ -z "$info" ]; then
    sql -c "update backup.pitr_repositories set status_since = case when status_code <> 99 then clock_timestamp() else status_since end, status_code = 99, status_message = 'pgbackrest info gave no answer', checked_at = clock_timestamp()"
    return 0
  fi
  # archive_max_seen_at: when this repository's newest segment changed, so how far it reaches back in time.
  sql -v info="$info" -f - <<'SQL'
with s as (select (:'info')::jsonb -> 0 as j),
repos as (
  select (r ->> 'key')::smallint as k, r ->> 'cipher' as cipher, (r -> 'status' ->> 'code')::int as code, r -> 'status' ->> 'message' as message
    from s, jsonb_array_elements(coalesce(s.j -> 'repo', '[]')) r),
arch as (
  select (a -> 'database' ->> 'repo-key')::smallint as k, min(a ->> 'min') as amin, max(a ->> 'max') as amax
    from s, jsonb_array_elements(coalesce(s.j -> 'archive', '[]')) a group by 1),
bk as (
  select (b -> 'database' ->> 'repo-key')::smallint as k, count(*)::int as n,
         to_timestamp(min((b -> 'timestamp' ->> 'stop')::bigint)) as oldest, to_timestamp(max((b -> 'timestamp' ->> 'stop')::bigint)) as newest
    from s, jsonb_array_elements(coalesce(s.j -> 'backup', '[]')) b group by 1)
insert into backup.pitr_repositories as p
       (repo_key, cipher, status_code, status_message, status_since, archive_min, archive_max, archive_max_seen_at, backups, oldest_backup_at, newest_backup_at, checked_at)
select repos.k, repos.cipher, repos.code, repos.message, clock_timestamp(), arch.amin, arch.amax, case when arch.amax is not null then clock_timestamp() end,
       coalesce(bk.n, 0), bk.oldest, bk.newest, clock_timestamp()
  from repos left join arch on arch.k = repos.k left join bk on bk.k = repos.k
on conflict (repo_key) do update set
       cipher = excluded.cipher, status_code = excluded.status_code, status_message = excluded.status_message,
       status_since = case when excluded.status_code is distinct from p.status_code then excluded.checked_at else p.status_since end,
       -- An unreachable repository reports no archive: keep what it last held rather than forget it.
       archive_min = coalesce(excluded.archive_min, p.archive_min),
       archive_max = coalesce(excluded.archive_max, p.archive_max),
       archive_max_seen_at = case when excluded.archive_max is not null and excluded.archive_max is distinct from p.archive_max
                                  then excluded.checked_at else p.archive_max_seen_at end,
       backups = case when excluded.status_code = 0 then excluded.backups else p.backups end,
       oldest_backup_at = case when excluded.status_code = 0 then excluded.oldest_backup_at else p.oldest_backup_at end,
       newest_backup_at = case when excluded.status_code = 0 then excluded.newest_backup_at else p.newest_backup_at end,
       checked_at = excluded.checked_at;
-- A repository taken out of the configuration is no longer reported.
with s as (select (:'info')::jsonb -> 0 as j)
delete from backup.pitr_repositories
 where repo_key not in (select (r ->> 'key')::smallint from s, jsonb_array_elements(coalesce(s.j -> 'repo', '[]')) r);
SQL
}

# --once: record now and stop (CI, and to see a change at once).
[ "${1:-}" = --once ] && { record; exit; }

while :; do
  record || echo "pgbackrest status: could not record the repositories' status" >&2
  sleep "$EVERY"
done
