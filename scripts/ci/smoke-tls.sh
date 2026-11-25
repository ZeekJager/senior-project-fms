#!/bin/sh
# The production stack at its edge (FMS-106, docs/deployment.md):
#
#   sh scripts/ci/smoke-tls.sh <image-tag>
#
# Starts docker-compose.prod.yml with the images of that tag, for localhost, with a certificate from Caddy's
# own authority (FMS_TLS_ISSUER=internal), and checks the card's criteria:
#
#   - HTTP redirects to HTTPS; the certificate is valid for the host; TLS 1.2 and 1.3 are accepted and 1.1 is
#     refused by the server; HSTS on the web app and on the API.
#   - The web app, the API and the Socket.IO socket (WSS) answer through the proxy.
#   - Both API instances take requests, and a browser keeps to one (the fms_lb cookie).
#   - Killing one instance keeps the site up: every request answers, whichever instance its cookie named. The
#     instance then rejoins.
#   - Only the proxy publishes ports; PostgreSQL, Redis and the AI service are on an internal network with no way out.
#
# Needs ports 80 and 443 free, curl and openssl. Secrets are generated for this run. Everything it starts
# is removed on exit.
set -eu

TAG="${1:?usage: smoke-tls.sh <image-tag>}"
PROJECT="fms-tls-$$"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/prod.env"
ROOT_CA="$WORK/root.crt"
JAR="$WORK/cookies"
URL="https://localhost"

# A path Docker reads from inside a file (Git Bash on Windows hands Docker its own /tmp otherwise).
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
secret() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
umask 077
cat >"$ENV_FILE" <<EOF
FMS_DOMAIN=localhost
FMS_TLS_ISSUER=internal
FMS_IMAGE_TAG=$TAG
DB_ADMIN_PASSWORD=$(secret 24)
DB_APP_PASSWORD=$(secret 24)
REDIS_PASSWORD=$(secret 24)
JWT_SECRET=$(secret 48)
DATA_ENCRYPTION_KEY=$(secret 48)
ML_SERVICE_TOKEN=$(secret 48)
FMS_API_ENV_FILE=$(native "$WORK/api.env")
EOF
# This run sends a few hundred anonymous requests from one address in two minutes: above the per-client limit
# (120 a minute), which is not what it tests.
echo "RATE_LIMIT_ANONYMOUS_PER_MINUTE=100000" >"$WORK/api.env"

dc() { docker compose -p "$PROJECT" -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    dc ps -a >&2 || true
    dc logs --no-color --tail=60 caddy api-1 api-2 web migrate >&2 || true
  fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "TLS SMOKE FAILED: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

# The status code of a request through the edge (000 when it got no answer).
status_of() { curl -s -o /dev/null --max-time 15 --ssl-no-revoke --cacert "$ROOT_CA" -w '%{http_code}' "$@" || true; }

wait_healthy() {
  for _ in $(seq 1 90); do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q "$1")" 2>/dev/null || echo starting)"
    [ "$state" = "healthy" ] && return 0
    sleep 2
  done
  fail "$1 did not become healthy"
}

echo "== Starting the production stack ($TAG) for localhost"
dc up -d
for service in api-1 api-2 web; do wait_healthy "$service"; done
# Caddy issues the certificate from its own authority at start; wait until HTTPS answers with it.
for _ in $(seq 1 60); do
  dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$ROOT_CA" >/dev/null 2>&1 \
    && [ "$(status_of "$URL/")" = "200" ] && break
  sleep 2
done
[ "$(status_of "$URL/")" = "200" ] || fail "HTTPS did not answer 200 with a certificate from the stack's authority"

echo "== TLS"
redirect="$(curl -s -o /dev/null --max-time 10 -w '%{http_code} %{redirect_url}' http://localhost/vehicles?page=2)"
[ "$redirect" = "308 https://localhost/vehicles?page=2" ] || fail "http:// answered '$redirect', not a permanent redirect to https://"
pass "HTTP redirects to HTTPS: $redirect"

# s_client prints the version it tried even when the handshake failed ("Protocol: TLSv1.1", "Cipher is (NONE)"):
# a handshake was made only when a cipher was agreed and the server sent its certificate.
handshake() { echo | openssl s_client -connect localhost:443 -servername localhost -CAfile "$ROOT_CA" -verify_return_error "$@" 2>&1 || true; }
agreed() { echo "$1" | grep -Eq "^New, TLSv$2, Cipher is [A-Z0-9_-]+" && ! echo "$1" | grep -q "no peer certificate available"; }
out="$(handshake -tls1_2)"
agreed "$out" "1.2" || fail "TLS 1.2 was refused: $(echo "$out" | grep -E '^New|error' | head -3)"
echo "$out" | grep -q "Verify return code: 0 (ok)" || fail "the certificate does not verify for localhost: $(echo "$out" | grep -i verify | head -3)"
pass "TLS 1.2 accepted, the certificate valid for localhost"
out="$(handshake -tls1_3)"
agreed "$out" "1.3" || fail "TLS 1.3 was refused: $(echo "$out" | grep -E '^New|error' | head -3)"
pass "TLS 1.3 accepted"
# The client is told to allow TLS 1.1 (security level 0) and sends its hello; the server answers with an alert.
out="$(handshake -tls1_1 -cipher 'DEFAULT@SECLEVEL=0')"
if agreed "$out" "1.1"; then fail "TLS 1.1 was accepted"; fi
echo "$out" | grep -q "Cipher is (NONE)" || fail "the TLS 1.1 attempt did not reach the server: $(echo "$out" | tail -3)"
pass "TLS 1.1 refused by the server"

hsts() { curl -sS -o /dev/null -D - --max-time 10 --ssl-no-revoke --cacert "$ROOT_CA" "$1" | tr -d '\r' | grep -i '^strict-transport-security:' || true; }
for path in / /api/v1/auth/me; do
  header="$(hsts "$URL$path")"
  echo "$header" | grep -qi "max-age=31536000; includeSubDomains" || fail "$path has no HSTS for a year with subdomains (got: '$header')"
done
pass "HSTS on the web app and the API"

echo "== Through the proxy"
curl -sS --max-time 10 --ssl-no-revoke --cacert "$ROOT_CA" "$URL/trips/some-route" | grep -qi '<div id="root"' || fail "an app route is not the app"
pass "the web app"
[ "$(status_of "$URL/api/v1/auth/me")" = "401" ] || fail "/api/v1/auth/me did not answer the API's 401"
pass "the API (401 without a session)"
# A WebSocket straight to Socket.IO, over TLS: 101 means the proxy upgraded it end to end.
ws="$(curl -sS -i -N --http1.1 --max-time 5 --ssl-no-revoke --cacert "$ROOT_CA" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" \
  "$URL/api/v1/socket.io/?EIO=4&transport=websocket" 2>/dev/null | head -1 | tr -d '\r' || true)"
echo "$ws" | grep -q " 101" || fail "the socket over WSS answered '$ws', not 101 Switching Protocols"
pass "WSS: $ws"

echo "== Two instances"
# A browser with no cookie is given one; 20 of them must between them have been sent to both instances.
cookies=""
for _ in $(seq 1 20); do
  value="$(curl -sS -o /dev/null -D - --max-time 10 --ssl-no-revoke --cacert "$ROOT_CA" "$URL/api/v1/auth/me" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: fms_lb=\([^;]*\).*/\1/p')"
  [ -n "$value" ] || fail "a request without the fms_lb cookie was not given one"
  cookies="$cookies
$value"
done
distinct="$(echo "$cookies" | sed '/^$/d' | sort -u)"
[ "$(echo "$distinct" | wc -l)" -eq 2 ] || fail "20 new browsers went to $(echo "$distinct" | wc -l) instance(s), not 2"
COOKIE_A="$(echo "$distinct" | sed -n 1p)"
COOKIE_B="$(echo "$distinct" | sed -n 2p)"
pass "requests spread over both instances"
again="$(curl -sS -o /dev/null -D - --max-time 10 --ssl-no-revoke --cacert "$ROOT_CA" -b "fms_lb=$COOKIE_A" "$URL/api/v1/auth/me" | tr -d '\r' | grep -ci '^set-cookie: fms_lb=' || true)"
[ "$again" = "0" ] || fail "a browser with its cookie was sent to another instance"
pass "a browser keeps to its instance"

echo "== Killing api-1"
failures=0
for i in $(seq 1 40); do
  if [ "$i" -eq 11 ]; then
    dc kill api-1 >/dev/null
    echo "  api-1 killed after 10 requests"
  fi
  # Both instances' cookies (one of them is api-1's), and a new browser.
  for jar in "fms_lb=$COOKIE_A" "fms_lb=$COOKIE_B" ""; do
    code="$(status_of -b "$jar" "$URL/api/v1/auth/me")"
    [ "$code" = "401" ] || { failures=$((failures + 1)); echo "  request $i (${jar:-no cookie}) answered $code"; }
  done
  [ "$(status_of "$URL/")" = "200" ] || { failures=$((failures + 1)); echo "  request $i to the web app failed"; }
done
[ "$(docker inspect -f '{{.State.Running}}' "$(dc ps -aq api-1)")" = "false" ] || fail "api-1 was not down"
[ "$failures" -eq 0 ] || fail "$failures of 160 requests failed with one instance down"
pass "160 requests, 0 failed, with api-1 down"

echo "== api-1 rejoins"
dc start api-1 >/dev/null
wait_healthy api-1
seen=""
for _ in $(seq 1 60); do
  value="$(curl -sS -o /dev/null -D - --max-time 10 --ssl-no-revoke --cacert "$ROOT_CA" "$URL/api/v1/auth/me" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: fms_lb=\([^;]*\).*/\1/p')"
  seen="$seen
$value"
  [ "$(echo "$seen" | sed '/^$/d' | sort -u | wc -l)" -eq 2 ] && break
  sleep 1
done
[ "$(echo "$seen" | sed '/^$/d' | sort -u | wc -l)" -eq 2 ] || fail "api-1 took no requests after it came back"
pass "new browsers reach both instances again"

echo "== Exposure"
published="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | grep -- '->' | cut -d' ' -f1 | sort -u | tr '\n' ' ')"
[ "$published" = "caddy " ] || fail "services publishing ports: '$published' (only caddy may)"
pass "only caddy publishes ports"
[ "$(docker network inspect -f '{{.Internal}}' "${PROJECT}_data")" = "true" ] || fail "the data network is not internal"
pass "the data network is internal"
# From inside it there is no way out: the AI service (on the data network only) cannot open a connection to the internet.
if dc exec -T ai-service python -c "import socket; socket.create_connection(('1.1.1.1', 443), 3)" >/dev/null 2>&1; then
  fail "the AI service reached the internet from the data network"
fi
pass "nothing on the data network reaches outside it"

echo "TLS smoke run passed."
