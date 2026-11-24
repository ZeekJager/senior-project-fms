#!/bin/sh
# The database's role, for the stable endpoint (FMS-162, docs/disaster-recovery.md): HAProxy's agent check
# (docker/db-proxy/haproxy.cfg) connects once a second and reads one line.
#
#   role-agent.sh primary   "up" when this server is the primary, else "down"   (port 5480)
#   role-agent.sh standby   "up" when it is a streaming standby, else "down"     (port 5481)
#
# A fenced server (fms.fenced in its data directory, written by scripts/dr/promote.sh) is "down" for both, so the
# endpoint never sends a write to an old primary that came back. Anything unknown is "down": a server is in the
# primary's pool only while it says, itself, that it is the primary.
want="${1:-primary}"
if [ -f "${PGDATA:-/var/lib/postgresql/data}/fms.fenced" ]; then echo "down"; exit 0; fi
role=$(psql -X -q -At -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c 'select pg_is_in_recovery()' 2>/dev/null)
case "$want:$role" in
  primary:f | standby:t) echo "up ready" ;;
  *) echo "down" ;;
esac
