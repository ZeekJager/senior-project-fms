#!/bin/sh
# The read replica on a running Compose stack (FMS-94, docs/read-replica.md):
#   1. it streams from the primary;
#   2. a write on the primary reaches it, and it refuses writes itself;
#   3. the API reads it (readiness: replica ok);
#   4. stopped, the API falls back (readiness: replica degraded, still 200),
#      and started again, the API uses it again.
# Used by the docker-stack CI job. COMPOSE and API_URL override the defaults
# for a stack started under another project name or port.
set -eu

COMPOSE=${COMPOSE:-docker compose}
API_URL=${API_URL:-http://localhost:3000}
primary() { $COMPOSE exec -T postgres psql -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -Atq "$@"; }
replica() { $COMPOSE exec -T postgres-replica psql -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -Atq "$@"; }

# Waits up to $1 tries (2 s apart) for readiness to report the replica as $2.
ready_replica() {
  tries=$1 want=$2 body=''
  for _ in $(seq 1 "$tries"); do
    body=$(curl -fsS "$API_URL/health/ready" || true)
    case "$body" in *"\"replica\":\"$want\""*) return 0 ;; esac
    sleep 2
  done
  echo "Readiness did not report the replica $want: $body"
  return 1
}

state=''
for _ in $(seq 1 30); do
  state=$(primary -c "select state from pg_stat_replication where state = 'streaming' limit 1" 2>/dev/null || true)
  [ "$state" = "streaming" ] && break
  sleep 2
done
[ "$state" = "streaming" ] || { echo "The replica is not streaming from the primary"; exit 1; }
echo "replica streaming: $(primary -c "select slot_name || ' active=' || active from pg_replication_slots where slot_name = 'fms_replica'")"

token=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
primary -c "create table public.replica_check (token text)" -c "insert into public.replica_check values ('$token')"
seen=''
for _ in $(seq 1 15); do
  seen=$(replica -c "select token from public.replica_check" 2>/dev/null || true)
  [ "$seen" = "$token" ] && break
  sleep 1
done
[ "$seen" = "$token" ] || { echo "A write on the primary did not reach the replica"; exit 1; }
if replica -c "insert into public.replica_check values ('x')" 2>/dev/null; then echo "The replica accepted a write"; exit 1; fi
primary -c "drop table public.replica_check"
echo "write on the primary reached the replica; the replica refused a write"

ready_replica 30 ok
echo "API reads the replica"

$COMPOSE stop postgres-replica
ready_replica 20 degraded
curl -fsS -o /dev/null "$API_URL/health/ready" || { echo "Readiness failed with the replica down"; exit 1; }
echo "replica down: readiness degraded, still 200"

$COMPOSE start postgres-replica
ready_replica 30 ok
echo "replica back in use"
echo REPLICA CHECK PASS
