#!/bin/sh
# CI check of failover (FMS-162, docs/disaster-recovery.md), on the running Compose stack (job docker-stack):
#   1. a writer sends 1,000 numbered rows through the stable endpoint (db-proxy:5432), each retried until it is
#      stored, as the phone's queue and devices retry a 503;
#   2. partway through, scripts/dr/promote.sh fences the primary and promotes the standby;
#   3. all 1,000 rows are stored, each once; the API's database is ok again, with no redeploy or change;
#   4. the fenced old primary refuses to start, rejoin.sh makes it the standby, and it has every row;
#   5. a failback (promote and rejoin again), so the stack ends as it started.
set -eu

TABLE=public.failover_check
WRITER=fms-ci-failover-writer
N=1000
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' fms_postgres)
IMAGE=$(docker inspect -f '{{.Config.Image}}' fms_postgres)

primary() { for s in fms_postgres fms_postgres_replica; do
  [ "$(docker exec -u postgres "$s" psql -X -q -At -h /var/run/postgresql -U fms_admin -d fms_db -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ] && { echo "$s"; return; }
done; }
on() { docker exec -u postgres "$1" psql -X -q -At -h /var/run/postgresql -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -c "$2"; }
cleanup() { docker rm -f "$WRITER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FIRST=$(primary)
[ "$FIRST" = fms_postgres ] || { echo "Expected fms_postgres to be the primary, found: ${FIRST:-none}" >&2; exit 1; }
on fms_postgres "create table if not exists $TABLE (n int primary key, at timestamptz default clock_timestamp())" >/dev/null
on fms_postgres "truncate $TABLE" >/dev/null

echo "== A writer: $N rows through db-proxy, each retried until stored"
# A retried insert may already have committed before its connection dropped: on conflict do nothing makes it once.
docker run -d --name "$WRITER" --network "$NETWORK" --entrypoint sh \
  -e PGPASSWORD="$(docker exec fms_postgres printenv DB_ADMIN_PASSWORD)" -e PGCONNECT_TIMEOUT=3 "$IMAGE" -c "
  i=1; retries=0
  while [ \$i -le $N ]; do
    until psql -X -q -h db-proxy -p 5432 -U fms_admin -d fms_db -c \"insert into $TABLE (n) values (\$i) on conflict do nothing\" >/dev/null 2>&1; do
      retries=\$((retries + 1)); sleep 0.2
    done
    i=\$((i + 1)); sleep 0.01
  done
  echo \"writer: $N rows sent, \$retries retries\"" >/dev/null

i=0
until [ "$(on fms_postgres "select count(*) from $TABLE" 2>/dev/null || echo 0)" -ge 200 ]; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { echo "The writer did not store 200 rows in 60 s" >&2; docker logs "$WRITER" >&2; exit 1; }
  sleep 0.5
done

echo "== Failover partway through"
START=$(date +%s)
sh scripts/dr/promote.sh --yes
echo "Service back $(( $(date +%s) - START )) s after the failover began"

until [ "$(docker inspect -f '{{.State.Running}}' "$WRITER")" = false ]; do sleep 1; done
docker logs "$WRITER"
STORED=$(on fms_postgres_replica "select count(*) || '/' || count(distinct n) || '/' || coalesce(min(n), 0) || '/' || coalesce(max(n), 0) from $TABLE")
[ "$STORED" = "$N/$N/1/$N" ] || { echo "Stored $STORED (rows/distinct/min/max), expected $N/$N/1/$N" >&2; exit 1; }
echo "All $N rows stored once, across the failover"

echo "== The fenced old primary refuses to start"
docker start fms_postgres >/dev/null 2>&1 || true
sleep 5
[ "$(docker inspect -f '{{.State.Running}}' fms_postgres)" = false ] || { echo "The fenced old primary is running" >&2; exit 1; }
docker logs --tail 5 fms_postgres 2>&1 | grep -q "fenced by a failover" || { echo "The fenced old primary did not say why it stopped" >&2; docker logs --tail 10 fms_postgres >&2; exit 1; }

echo "== It rejoins as the standby, with every row"
sh scripts/dr/rejoin.sh
i=0
until [ "$(on fms_postgres "select count(*) from $TABLE" 2>/dev/null)" = "$N" ]; do
  i=$((i + 1)); [ "$i" -gt 30 ] && { echo "The rejoined standby does not have the $N rows" >&2; exit 1; }
  sleep 1
done
[ "$(on fms_postgres 'select pg_is_in_recovery()')" = t ] || { echo "The rejoined server is not a standby" >&2; exit 1; }

echo "== Failback: fms_postgres the primary again"
sh scripts/dr/promote.sh --yes
sh scripts/dr/rejoin.sh
[ "$(primary)" = fms_postgres ] || { echo "After the failback the primary is $(primary)" >&2; exit 1; }
on fms_postgres "drop table $TABLE" >/dev/null
echo "Failover passed: $N rows stored once across it, the old primary fenced, rejoined and failed back."
