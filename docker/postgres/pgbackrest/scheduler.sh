#!/bin/sh
# Base backup schedule of the primary database (FMS-108, docs/backups.md). Runs as the postgres user,
# started by entrypoint.sh once the server is up.
#
# - At once, when the repository holds no backup yet: a full one, so point-in-time recovery works
#   from the first start (with no base backup, archived WAL alone cannot be restored).
# - Then every day at BACKUP_BASE_HOUR_UTC (default 22, which is 01:00 in Addis Ababa): a full backup
#   on Sundays (Addis Ababa time), a differential one on other days.
#
# A failed backup is recorded by backup.sh and tried again the next day; the Backups screen and System
# health show it. BACKUP_SCHEDULE=off turns the schedule off (archiving continues).
set -u

HOUR="${BACKUP_BASE_HOUR_UTC:-22}"
[ "${BACKUP_SCHEDULE:-on}" = off ] && { echo "pgbackrest: base backup schedule is off"; exit 0; }

if ! pgbackrest --stanza=fms --output=json info 2>/dev/null | grep -q '"label"'; then
  /usr/local/bin/fms-pgbackrest/backup.sh full first-start || true
fi

while :; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow ${HOUR}:00" +%s)
  sleep $((next - now))
  # Sunday in Addis Ababa (UTC+3, no daylight saving) at the time the backup starts.
  if [ "$(date -u -d '+3 hours' +%u)" = 7 ]; then type=full; else type=diff; fi
  /usr/local/bin/fms-pgbackrest/backup.sh "$type" schedule || true
done
