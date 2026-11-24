#!/bin/sh
# Entry point of the primary database image (FMS-108, docs/backups.md).
#
# Starts PostgreSQL through the image's own docker-entrypoint.sh, unchanged, and beside it, as the
# postgres user, once the server accepts TCP connections (the temporary server of a first start does
# not, so this never runs against it):
#   1. stanza-create: pgBackRest's repository for this cluster. Idempotent, so it also works on a
#      volume created before this card, and archiving catches up from pg_wal once it exists;
#   2. the repositories' status loop (status.sh), once a minute, for the Backups screen, System health
#      and the backup alerts;
#   3. the base backup scheduler (scheduler.sh), which takes a first full backup at once when the
#      repository has none, so point-in-time recovery works from the first start, and runs the monthly
#      restore drill (drill.sh).
#
# The repository's passphrase comes from the environment; without it nothing starts, because an
# unencrypted backup must never be written.
set -eu

: "${PGBACKREST_REPO1_CIPHER_PASS:?is not set - run node scripts/init-env.mjs to add BACKUP_REPO_CIPHER_PASS to .env}"

if [ "$(id -u)" = 0 ]; then
  chown postgres:postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest
fi

as_postgres() {
  if [ "$(id -u)" = 0 ]; then gosu postgres "$@"; else "$@"; fi
}

(
  until pg_isready -q -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"; do sleep 2; done
  as_postgres pgbackrest --stanza=fms --log-level-console=warn stanza-create \
    || echo "pgbackrest: stanza-create failed; archiving waits until it succeeds (see /var/log/pgbackrest)" >&2
  as_postgres /usr/local/bin/fms-pgbackrest/status.sh &
  as_postgres /usr/local/bin/fms-pgbackrest/scheduler.sh
) &

exec docker-entrypoint.sh "$@"
