#!/bin/sh
# Resilience drills (FMS-111, docs/resilience.md): on the Compose stack, each dependency is taken away while the API is
# asked something every second, then given back. Each drill records what the API did and how long it took to recover,
# and fails when that is outside its target.
#
#   sh scripts/ci/check-resilience.sh [--report <file.md>]
#
#   FMS_API_URL          the API (default http://localhost:3000)
#   FMS_DRILL_EMAIL      an administrator, to probe signed-in routes as well: GET /vehicles (the primary) and
#   FMS_DRILL_PASSWORD   GET /analytics/fleet-summary (the read replica). Without them only the public probes run.
#
# The drills:  redis      Redis stopped     the API serves, readiness 200 "degraded";  back within 30 s
#              ml         AI service stopped the API serves, readiness 200 "degraded"; back within 60 s
#              replica    read replica stopped reads go to the primary, readiness 200;   back within 60 s
#              api        the API killed     (one instance: down until restarted)      back within 90 s
# The provider drill is test/integration/resilience.test.ts; the database failover is scripts/ci/check-failover.sh.
set -eu

API="${FMS_API_URL:-http://localhost:3000}"
REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
OUTAGE_SECONDS="${FMS_DRILL_OUTAGE_SECONDS:-20}"
WORK="$(mktemp -d)"
JAR="$WORK/cookies"
ROWS="$WORK/rows"
: >"$ROWS"
FAILED=0
trap 'docker start fms_redis fms_ai_service fms_postgres_replica fms_backend >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

now() { date +%s; }
code() { curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$@" || true; }
ready_body() { curl -s --max-time 5 "$API/health/ready" || true; }
check_is() { ready_body | grep -q "\"$1\":\"$2\""; }

signed_in=0
if [ -n "${FMS_DRILL_EMAIL:-}" ] && [ -n "${FMS_DRILL_PASSWORD:-}" ]; then
  body="$(printf '{"email":"%s","password":"%s"}' "$FMS_DRILL_EMAIL" "$FMS_DRILL_PASSWORD")"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'content-type: application/json' -d "$body" "$API/api/v1/auth/login")" = 200 ] \
    || { echo "Could not sign in as FMS_DRILL_EMAIL" >&2; exit 1; }
  signed_in=1
fi

# One probe: readiness answers 200, a route answers as it should (401 without a session), and with a session a primary
# read and a replica read answer 200. Prints what failed, nothing when all is well.
probe() {
  r="$(code "$API/health/ready")"; [ "$r" = 200 ] || echo "ready=$r"
  m="$(code "$API/api/v1/auth/me")"; [ "$m" = 401 ] || echo "me=$m"
  if [ "$signed_in" = 1 ]; then
    v="$(code -b "$JAR" "$API/api/v1/vehicles?page_size=5")"; [ "$v" = 200 ] || echo "vehicles=$v"
    a="$(code -b "$JAR" "$API/api/v1/analytics/fleet-summary")"; [ "$a" = 200 ] || echo "fleet-summary=$a"
  fi
}

# drill <name> <container> <readiness check> <what the API does meanwhile> <recovery target, s>
drill() {
  name="$1" container="$2" check="$3" behaviour="$4" target="$5"
  echo "== $name: $container stopped for ${OUTAGE_SECONDS} s"
  check_is "$check" ok || { echo "  $check is not ok before the drill: $(ready_body)" >&2; FAILED=1; return; }
  failures=0; probes=0; detected=""
  docker stop "$container" >/dev/null
  start=$(now)
  while [ $(( $(now) - start )) -lt "$OUTAGE_SECONDS" ]; do
    out="$(probe)"; probes=$((probes + 1))
    [ -n "$out" ] && { failures=$((failures + 1)); echo "  failed: $out"; }
    [ -z "$detected" ] && ! check_is "$check" ok && detected=$(( $(now) - start ))
    sleep 1
  done
  docker start "$container" >/dev/null
  back=$(now)
  until check_is "$check" ok; do
    out="$(probe)"; probes=$((probes + 1))
    [ -n "$out" ] && { failures=$((failures + 1)); echo "  failed: $out"; }
    [ $(( $(now) - back )) -gt $((target * 3)) ] && break
    sleep 1
  done
  recovery=$(( $(now) - back ))
  verdict=pass
  [ "$failures" -eq 0 ] || verdict=fail
  [ -n "$detected" ] || verdict=fail
  [ "$recovery" -le "$target" ] || verdict=fail
  [ "$verdict" = pass ] || FAILED=1
  echo "  $probes probes, $failures failed; readiness said $check degraded after ${detected:-never} s; back ${recovery} s after restart (target ${target} s): $verdict"
  echo "| $name | $behaviour | $probes / $failures | ${detected:-never} s | ${recovery} s | ${target} s | $verdict |" >>"$ROWS"
}

drill "Redis stopped" fms_redis redis "Serves; rate limits count in each instance; events wait in the outbox" 30
drill "AI service stopped" fms_ai_service ml "Serves; scoring and trip risk wait (\`checks.ml\` degraded)" 60
drill "Read replica stopped" fms_postgres_replica replica "Serves; reports read the primary" 60

# The API itself. One instance in this stack, so it is down until it is back: what is measured is how long it takes
# to answer again. Behind the production proxy (two instances, docs/deployment.md) the other one answers meanwhile.
echo "== API instance killed"
docker kill fms_backend >/dev/null
down=$(now)
[ "$(code "$API/health/ready")" != 200 ] || { echo "  the API still answers after being killed" >&2; FAILED=1; }
docker start fms_backend >/dev/null
until [ "$(code "$API/health/ready")" = 200 ]; do
  [ $(( $(now) - down )) -gt 270 ] && break
  sleep 1
done
recovery=$(( $(now) - down ))
[ "$signed_in" = 1 ] && { [ "$(code -b "$JAR" "$API/api/v1/vehicles?page_size=5")" = 200 ] || { echo "  the session did not survive the restart" >&2; FAILED=1; }; }
verdict=pass; [ "$recovery" -le 90 ] || { verdict=fail; FAILED=1; }
echo "  answering again ${recovery} s after it was killed (target 90 s): $verdict"
echo "| API instance killed | One instance: unavailable until restarted, sessions kept; the web app says it is reconnecting | - | - | ${recovery} s | 90 s | $verdict |" >>"$ROWS"

table="$(printf '| Drill | What the API did | Probes / failed | Degraded reported after | Recovered after | Target | Result |\n|---|---|---|---|---|---|---|\n'; cat "$ROWS")"
echo
echo "$table"
[ -n "$REPORT" ] && printf '%s\n' "$table" >"$REPORT"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '## Resilience drills\n\n%s\n' "$table" >>"$GITHUB_STEP_SUMMARY"
[ "$FAILED" -eq 0 ] || { echo "A drill missed its target." >&2; exit 1; }
echo "Every drill within its target."
