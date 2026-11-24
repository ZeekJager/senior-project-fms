#!/bin/sh
# Entry point of both database containers, the primary and its standby (FMS-108, FMS-162; docs/backups.md,
# docs/disaster-recovery.md). Either can be the primary: a failover (scripts/dr/promote.sh) promotes the standby, and
# the old primary rejoins as the standby (scripts/dr/rejoin.sh). The same image, settings and backup repository on
# both, so the one that is the primary always archives its WAL and takes the base backups.
#
#   FMS_ROLE=primary   (default) a new, empty volume becomes an empty database (the image's docker-entrypoint.sh);
#   FMS_ROLE=standby   a new, empty volume is copied from the primary (standby.sh).
# After that the data directory decides: with standby.signal the server is a standby, and every start makes sure the
# primary has the replication role and slot; without it, the primary.
#
# A server fenced by a failover (fms.fenced in its data directory) does not start: it would be a second primary.
# scripts/dr/rejoin.sh turns it into the standby and removes the fence.
#
# Beside PostgreSQL, as the postgres user:
#   1. the role agents for the stable endpoint (role-agent.sh; HAProxy asks them once a second): port 5480 answers
#      whether this server is the primary, 5481 whether it is a standby;
#   2. once this server is the primary (at once, or after it is promoted): pgBackRest's stanza-create (idempotent;
#      archiving catches up from pg_wal once it exists), the repositories' status loop (status.sh) and the base backup
#      scheduler (scheduler.sh), which takes a first full backup when a repository has none and runs the monthly
#      restore drill (drill.sh). A standby takes no backups and writes nothing.
#
# The repository's passphrase comes from the environment; without it nothing starts, because an unencrypted backup
# must never be written.
set -eu

: "${PGBACKREST_REPO1_CIPHER_PASS:?is not set - run node scripts/init-env.mjs to add BACKUP_REPO_CIPHER_PASS to .env}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export PGDATA
BIN=/usr/local/bin/fms-pgbackrest

if [ -f "$PGDATA/fms.fenced" ]; then
  echo "This database was fenced by a failover on $(cat "$PGDATA/fms.fenced"): another server is the primary now." >&2
  echo "It does not start as a primary. Make it the standby with: sh scripts/dr/rejoin.sh (docs/disaster-recovery.md)." >&2
  exit 1
fi

if [ "$(id -u)" = 0 ]; then
  chown postgres:postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest
  # The data directory says what this server is: standby.signal, a standby (whichever container it is in, after a
  # failover); an empty volume, what FMS_ROLE says. A standby makes sure the primary has its role and slot, and an
  # empty one is copied from the primary first.
  if [ -f "$PGDATA/standby.signal" ] || { [ "${FMS_ROLE:-primary}" = standby ] && [ ! -s "$PGDATA/PG_VERSION" ]; }; then
    # With no primary reachable, a standby that has data starts all the same (it still serves reads); an empty one cannot.
    "$BIN/standby.sh" || [ -s "$PGDATA/PG_VERSION" ] || exit 1
  fi
fi

as_postgres() {
  if [ "$(id -u)" = 0 ]; then gosu postgres "$@"; else "$@"; fi
}

# Every helper is started detached, ( ... & ): its parent exits at once, so it belongs to tini (PID 1), never to the
# PostgreSQL this shell becomes with exec below. The postmaster takes any child of its own that exits badly for a
# crashed server process and restarts the whole server.
# The role agents: one line per connection, for HAProxy's agent check.
( as_postgres socat -T 5 TCP-LISTEN:5480,fork,reuseaddr SYSTEM:"$BIN/role-agent.sh primary" & )
( as_postgres socat -T 5 TCP-LISTEN:5481,fork,reuseaddr SYSTEM:"$BIN/role-agent.sh standby" & )

( (
  is_primary() {
    [ "$(psql -X -q -At -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ]
  }
  until pg_isready -q -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"; do sleep 2; done
  # A standby waits here until it is promoted: backups and the status are the primary's.
  until is_primary; do sleep 5; done
  as_postgres pgbackrest --stanza=fms --log-level-console=warn stanza-create \
    || echo "pgbackrest: stanza-create failed; archiving waits until it succeeds (see /var/log/pgbackrest)" >&2
  as_postgres "$BIN/status.sh" &
  as_postgres "$BIN/scheduler.sh"
) & )

exec docker-entrypoint.sh "$@"
