#!/bin/sh
# Smoke run of the production images (FMS-105, docs/production-images.md).
#
#   sh scripts/ci/smoke-images.sh <backend-image> <frontend-image> <ai-service-image>
#
# Starts PostgreSQL and Redis, migrates the schema with the backend image, starts the three images
# the way a deployment does (NODE_ENV=production) and checks that each answers, that the web app
# reaches the API through nginx, and that none of them runs as root. Secrets are generated here,
# for this run only. Everything it starts is removed on exit.
set -eu

BACKEND_IMAGE="${1:?usage: smoke-images.sh <backend-image> <frontend-image> <ai-service-image>}"
FRONTEND_IMAGE="${2:?usage: smoke-images.sh <backend-image> <frontend-image> <ai-service-image>}"
AI_IMAGE="${3:?usage: smoke-images.sh <backend-image> <frontend-image> <ai-service-image>}"

NET="fms-smoke-$$"
PREFIX="fms-smoke-$$"
secret() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
DB_ADMIN_PASSWORD="$(secret 24)"
DB_APP_PASSWORD="$(secret 24)"
REDIS_PASSWORD="$(secret 24)"
JWT_SECRET="$(secret 48)"
DATA_ENCRYPTION_KEY="$(secret 48)"
ML_SERVICE_TOKEN="$(secret 48)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for c in backend frontend ai postgres; do
      echo "----- logs: $PREFIX-$c" >&2
      docker logs --tail=60 "$PREFIX-$c" >&2 2>&1 || true
    done
  fi
  docker rm -f "$PREFIX-backend" "$PREFIX-frontend" "$PREFIX-ai" "$PREFIX-redis" "$PREFIX-postgres" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

# Waits until a container's own HEALTHCHECK says healthy.
wait_healthy() {
  name="$1"; tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)"
    [ "$state" = "healthy" ] && { echo "$name is healthy."; return 0; }
    [ "$state" = "unhealthy" ] && fail "$name is unhealthy"
    sleep 2
  done
  fail "$name did not become healthy"
}

# Fails when the container's processes run as root.
not_root() {
  uid="$(docker exec "$1" id -u)"
  [ "$uid" != "0" ] || fail "$1 runs as root"
  echo "$1 runs as uid $uid."
}

docker network create "$NET" >/dev/null

echo "== PostgreSQL and Redis"
docker run -d --name "$PREFIX-postgres" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=fms_admin -e POSTGRES_PASSWORD="$DB_ADMIN_PASSWORD" -e POSTGRES_DB=fms_db \
  -e DB_APP_PASSWORD="$DB_APP_PASSWORD" \
  -v "$(pwd)/docker/postgres/init:/docker-entrypoint-initdb.d:ro" \
  postgres:16 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PREFIX-postgres" pg_isready -h localhost -U fms_admin -d fms_db >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PREFIX-postgres" pg_isready -h localhost -U fms_admin -d fms_db >/dev/null 2>&1 || fail "PostgreSQL did not start"
docker run -d --name "$PREFIX-redis" --network "$NET" --network-alias redis \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" redis:7.4-alpine \
  sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no' >/dev/null

echo "== Migrations, run by the backend image"
docker run --rm --network "$NET" \
  -e DB_HOST=postgres -e DB_NAME=fms_db -e DB_USER=fms_app -e DB_PASSWORD="$DB_APP_PASSWORD" \
  -e DB_ADMIN_USER=fms_admin -e DB_ADMIN_PASSWORD="$DB_ADMIN_PASSWORD" -e DATA_ENCRYPTION_KEY="$DATA_ENCRYPTION_KEY" \
  "$BACKEND_IMAGE" node dist/scripts/migrate.js | tail -3

echo "== Backend"
docker run -d --name "$PREFIX-backend" --network "$NET" --network-alias backend \
  -e NODE_ENV=production \
  -e DB_HOST=postgres -e DB_NAME=fms_db -e DB_USER=fms_app -e DB_PASSWORD="$DB_APP_PASSWORD" \
  -e JWT_SECRET="$JWT_SECRET" -e DATA_ENCRYPTION_KEY="$DATA_ENCRYPTION_KEY" \
  -e REDIS_HOST=redis -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  -e ML_SERVICE_URL=http://ai-service:5000 -e ML_SERVICE_TOKEN="$ML_SERVICE_TOKEN" \
  "$BACKEND_IMAGE" >/dev/null
wait_healthy "$PREFIX-backend"
not_root "$PREFIX-backend"
docker exec "$PREFIX-backend" sh -c 'command -v pg_dump >/dev/null' || fail "pg_dump is missing from the backend image"
# Production serves no documentation page, and the image has no dev dependencies.
docker exec "$PREFIX-backend" sh -c '! test -d /app/node_modules/tsx && ! test -d /app/node_modules/swagger-ui-dist' \
  || fail "the backend image has dev dependencies"

echo "== ML service"
docker run -d --name "$PREFIX-ai" --network "$NET" --network-alias ai-service \
  -e ML_SERVICE_TOKEN="$ML_SERVICE_TOKEN" "$AI_IMAGE" >/dev/null
wait_healthy "$PREFIX-ai"
not_root "$PREFIX-ai"

echo "== Web app"
docker run -d --name "$PREFIX-frontend" --network "$NET" -e API_UPSTREAM=http://backend:3000 "$FRONTEND_IMAGE" >/dev/null
wait_healthy "$PREFIX-frontend"
not_root "$PREFIX-frontend"
# index.html at the root and at an app route; a missing asset is a 404, not index.html.
docker exec "$PREFIX-frontend" wget -qO- http://127.0.0.1:8080/ | grep -qi '<div id="root"' || fail "/ is not the app"
docker exec "$PREFIX-frontend" wget -qO- http://127.0.0.1:8080/vehicles/some-route | grep -qi '<div id="root"' || fail "an app route is not the app"
code="$(docker exec "$PREFIX-frontend" wget -S -qO- http://127.0.0.1:8080/assets/missing.js 2>&1 | awk '/HTTP\//{print $2; exit}')"
[ "$code" = "404" ] || fail "a missing asset answered $code, not 404"
# The API through nginx: a protected route answers 401 from the backend, not 502 from nginx.
code="$(docker exec "$PREFIX-frontend" wget -S -qO- http://127.0.0.1:8080/api/v1/auth/me 2>&1 | awk '/HTTP\//{print $2; exit}')"
[ "$code" = "401" ] || fail "/api/v1/auth/me through nginx answered $code, not 401"

echo "Smoke run passed."
