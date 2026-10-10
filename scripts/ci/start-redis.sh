#!/bin/sh
# Starts a throwaway Redis 7 for a CI job on localhost:6379 (FMS-72), with
# the password from REDIS_PASSWORD, generated earlier in the job. The
# integration tests use it for the cache, the login throttle and job locks.
set -eu

: "${REDIS_PASSWORD:?REDIS_PASSWORD is not set}"

docker run -d --name fms-ci-redis -p 6379:6379 -e REDIS_PASSWORD="${REDIS_PASSWORD}" \
  redis:7.4-alpine sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no' >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e REDISCLI_AUTH="${REDIS_PASSWORD}" fms-ci-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "Redis is ready."
    exit 0
  fi
  sleep 1
done

echo "Redis did not become ready within 30 s." >&2
docker logs fms-ci-redis >&2
exit 1
