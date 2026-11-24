#!/bin/sh
# Base backup schedule of the primary database (FMS-108, docs/backups.md). Runs as the postgres user,
# started by entrypoint.sh once the server is up.
#
# - At once, for each repository that holds no backup yet: a full one, so point-in-time recovery works
#   from the first start (with no base backup, archived WAL alone cannot be restored).
# - Then every day at BACKUP_BASE_HOUR_UTC (default 22, which is 01:00 in Addis Ababa): a full backup
#   on Sundays (Addis Ababa time), a differential one on other days.
#
# - After that night's backup, the restore drill (drill.sh) when none has passed in 30 days: so monthly.
#
# A failed backup is recorded by backup.sh and tried again the next day; the Backups screen and System
# health show it. BACKUP_SCHEDULE=off turns the schedule off (archiving continues); DRILL_SCHEDULE=off
# only the drill.
set -u

HOUR="${BACKUP_BASE_HOUR_UTC:-22}"

# "t" when a point-in-time drill is due: none passed in the last 30 days (and migration 076 is applied).
drill_due() {
  psql -X -q -At -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c "
    select to_regclass('backup.pitr_repositories') is not null and not exists (
      select 1 from backup.restore_drills
       where method = 'pitr' and status = 'succeeded' and finished_at > now() - interval '30 days')" 2>/dev/null
}
[ "${BACKUP_SCHEDULE:-on}" = off ] && { echo "pgbackrest: base backup schedule is off"; exit 0; }

# Per repository: one added later (the off-site one) gets its first full backup on the next start.
for repo in $(pgbackrest --stanza=fms --output=json info 2>/dev/null | grep -o '"key":[0-9]*' | cut -d: -f2 | sort -un); do
  if ! pgbackrest --stanza=fms --repo="$repo" --output=json info 2>/dev/null | grep -q '"label"'; then
    /usr/local/bin/fms-pgbackrest/backup.sh full first-start "$repo" || true
  fi
done

while :; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow ${HOUR}:00" +%s)
  sleep $((next - now))
  # Sunday in Addis Ababa (UTC+3, no daylight saving) at the time the backup starts.
  if [ "$(date -u -d '+3 hours' +%u)" = 7 ]; then type=full; else type=diff; fi
  /usr/local/bin/fms-pgbackrest/backup.sh "$type" schedule || true
  # The monthly restore drill, after the night's backup: when no point-in-time drill has passed in the
  # last 30 days. A failed one is tried again the next night; the alert stays until one passes.
  if [ "${DRILL_SCHEDULE:-on}" = on ] && [ "$(drill_due)" = t ]; then
    /usr/local/bin/fms-pgbackrest/drill.sh schedule || true
  fi
done
