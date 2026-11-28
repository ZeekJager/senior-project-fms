#!/bin/sh
# The release checklist's machine checks (FMS-112, docs/release.md): run on the server, from the repository root,
# before the go/no-go meeting and again after the release tag is deployed.
#
#   sh scripts/deploy/release-check.sh                 # every check against prod.env
#   sh scripts/deploy/release-check.sh --allow-demo    # UAT on the demo seed: demo accounts are a warning, not a failure
#   ENV_FILE=staging.env sh scripts/deploy/release-check.sh
#   COMPOSE_FILE=docker-compose.prod.yml:docker-compose.tunnel.yml:docker-compose.routing.yml sh scripts/deploy/release-check.sh
#
# The stack's compose files: COMPOSE_FILE from the environment, else from the env file, else docker-compose.prod.yml.
#
# Prints PASS, WARN or FAIL per check and exits 1 when anything failed. It never prints a secret: it reads prod.env
# only to test that each secret is set, long enough and not a placeholder.
set -u

ENV_FILE=${ENV_FILE:-prod.env}
ALLOW_DEMO=0
for arg in "$@"; do
  case "$arg" in
    --allow-demo) ALLOW_DEMO=1 ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

failed=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failed=1; }

if [ ! -f "$ENV_FILE" ]; then
  echo "FAIL  $ENV_FILE not found (run from the repository root, or set ENV_FILE)"
  exit 1
fi

# A value from the env file, without sourcing it (nothing in it runs) and without echoing it.
value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }

echo "== Configuration ($ENV_FILE)"
mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')
if [ "$mode" = "600" ]; then pass "$ENV_FILE is mode 600"; else fail "$ENV_FILE is mode $mode; chmod 600 it"; fi
for key in DB_ADMIN_PASSWORD DB_APP_PASSWORD REDIS_PASSWORD JWT_SECRET DATA_ENCRYPTION_KEY ML_SERVICE_TOKEN; do
  v=$(value "$key")
  case "$v" in
    '' ) fail "$key is not set" ;;
    change-me* | changeme* | password* | secret* | example* ) fail "$key is still a placeholder; generate it (scripts/deploy/init-prod-env.sh)" ;;
    * ) if [ "${#v}" -ge 32 ]; then pass "$key is set (${#v} characters)"; else fail "$key is only ${#v} characters; 32 or more"; fi ;;
  esac
done
csp=$(value CSP_MODE)
if [ "$csp" = "enforce" ]; then pass "CSP_MODE is enforce"; else warn "CSP_MODE is ${csp:-unset}: switch to enforce a week after launch (docs/security.md)"; fi
domain=$(value FMS_DOMAIN)
tag=$(value FMS_IMAGE_TAG)

echo "== The release"
if exact=$(git describe --tags --exact-match HEAD 2>/dev/null); then pass "the checkout is release tag $exact"; else fail "the checkout is not a release tag (git checkout vX.Y.Z)"; fi
head=$(git rev-parse --short=7 HEAD 2>/dev/null || echo '?')
if [ "$tag" = "$head" ]; then pass "FMS_IMAGE_TAG is the checkout ($head)"; else fail "FMS_IMAGE_TAG is ${tag:-unset}, the checkout is $head: build and set the tag's images"; fi

COMPOSE_FILE=${COMPOSE_FILE:-$(value COMPOSE_FILE)}
export COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

echo "== Containers"
if ! ps=$(compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null); then
  fail "docker compose cannot read the stack (is Docker running?)"
  ps=''
fi
echo "$ps" | while IFS='|' read -r service state health code; do
  [ -z "$service" ] && continue
  case "$service" in
    migrate | osrm-download | osrm-prepare)
      if [ "$state" = "exited" ] && [ "$code" = "0" ]; then echo "PASS  $service exited 0"; else echo "FAIL  $service is $state (exit $code)"; fi ;;
    *)
      if [ "$state" = "running" ] && { [ -z "$health" ] || [ "$health" = "healthy" ]; }; then echo "PASS  $service running${health:+, $health}"; else echo "FAIL  $service is $state${health:+, $health}"; fi ;;
  esac
done > /tmp/fms-release-containers.$$
cat /tmp/fms-release-containers.$$
grep -q '^FAIL' /tmp/fms-release-containers.$$ && failed=1
[ -s /tmp/fms-release-containers.$$ ] || fail "no containers found"
rm -f /tmp/fms-release-containers.$$

sql() { compose exec -T postgres psql -U fms_admin -d fms_db -At -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }

echo "== Database"
applied=$(sql "SELECT count(*) FROM schema_migrations")
files=$(ls packages/backend/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
if [ -n "$applied" ] && [ "$applied" = "$files" ]; then pass "all $files migrations applied"; else fail "migrations applied: ${applied:-unknown} of $files"; fi
demo=$(sql "SELECT count(*) FROM auth.users WHERE is_active AND lower(email) LIKE '%@fleet.demo'")
if [ "${demo:-x}" = "0" ]; then
  pass "no active demo accounts (@fleet.demo)"
elif [ "$ALLOW_DEMO" = "1" ]; then
  warn "$demo active demo accounts (@fleet.demo) share the seed password; remove them before go-live"
else
  fail "${demo:-unknown} active demo accounts (@fleet.demo) share the seed password; deactivate them, or reset the database and seed the real data (docs/release.md)"
fi
admins=$(sql "SELECT count(*) FROM auth.users u JOIN auth.user_roles ur ON ur.user_id = u.id JOIN auth.roles r ON r.id = ur.role_id WHERE u.is_active AND r.name = 'admin' AND lower(u.email) NOT LIKE '%@fleet.demo'")
if [ "${admins:-0}" -ge 1 ] 2>/dev/null; then pass "$admins named administrator account(s)"; else fail "no administrator other than a demo one: create one (dist/scripts/create-user.js, docs/deployment.md phase 8)"; fi
backup=$(sql "SELECT count(*) FROM backup.backups WHERE status = 'succeeded' AND finished_at > now() - interval '26 hours'")
if [ "${backup:-0}" -ge 1 ] 2>/dev/null; then pass "a backup succeeded in the last 26 hours"; else fail "no backup succeeded in the last 26 hours: Back up now, and check the schedule (docs/backups.md)"; fi
drill=$(sql "SELECT count(*) FROM backup.restore_drills WHERE status = 'succeeded' AND finished_at > now() - interval '31 days'")
if [ "${drill:-0}" -ge 1 ] 2>/dev/null; then pass "a restore drill succeeded in the last 31 days"; else fail "no successful restore drill in the last 31 days (docs/deployment.md phase 9)"; fi

echo "== Through the domain"
if [ -z "$domain" ]; then
  fail "FMS_DOMAIN is not set"
else
  ready=$(curl -s -o /dev/null -w '%{http_code}' "https://$domain/health/ready")
  if [ "$ready" = "200" ]; then pass "https://$domain/health/ready answers 200"; else fail "https://$domain/health/ready answers $ready"; fi
  me=$(curl -s -o /dev/null -w '%{http_code}' "https://$domain/api/v1/auth/me")
  if [ "$me" = "401" ]; then pass "the API refuses an anonymous /auth/me (401)"; else fail "/auth/me answers $me to an anonymous caller"; fi
  redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$domain/")
  case "$redirect" in
    30[178]\ https://*) pass "plain HTTP redirects to HTTPS (${redirect%% *})" ;;
    *) fail "plain HTTP answers '$redirect', not a redirect to HTTPS (Cloudflare: Always Use HTTPS)" ;;
  esac
  if curl -sI "https://$domain/" | grep -qi '^strict-transport-security:.*max-age=31536000'; then pass "HSTS is sent"; else fail "no HSTS header on https://$domain/"; fi
  if command -v openssl > /dev/null 2>&1; then
    # SECLEVEL=0 so this openssl offers TLS 1.1 at all: otherwise a modern client refuses it itself and the check passes
    # whatever the server does.
    old=$(echo | openssl s_client -connect "$domain:443" -servername "$domain" -tls1_1 -cipher 'DEFAULT@SECLEVEL=0' 2>/dev/null | sed -n 's/^ *Protocol *: *//p' | head -n 1)
    if [ "$old" = "TLSv1.1" ]; then
      fail "TLS 1.1 is accepted (Cloudflare: Minimum TLS Version 1.2)"
    else
      pass "TLS 1.1 is refused"
    fi
  else
    warn "openssl not found: check the TLS grade at https://www.ssllabs.com/ssltest/"
  fi
fi

echo
if [ "$failed" = "0" ]; then echo "Release checks: no failures."; else echo "Release checks: FAILED. Fix the FAIL lines before the go/no-go."; fi
exit "$failed"
