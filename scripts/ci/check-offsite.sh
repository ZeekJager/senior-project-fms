#!/bin/sh
# CI check of the off-site backup repository (FMS-108, docs/backups.md#off-site-repository), on the running
# Compose stack (job docker-stack), with SeaweedFS's S3 API standing in for the off-site bucket:
#   1. repo2 is added (docker/postgres/offsite.env) and the database recreated: its first full backup is taken
#      and every new WAL segment reaches both repositories within 60 s;
#   2. the network to it is cut: archiving reports failures while repo1 keeps every segment;
#   3. the network comes back: archiving catches up, and repo2 holds every segment again.
# The alert this raises (critical within 5 minutes) is the API's, tested in test/integration/pitr.test.ts.
set -eu

S3=fms-ci-offsite-s3
IMAGE=chrislusf/seaweedfs:4.50
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' fms_postgres)
# OFFSITE_WORK: a folder docker can mount (on Windows, a C:/ path); by default a new temporary one.
WORK="${OFFSITE_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
# mktemp -d is the owner's only: SeaweedFS reads its certificate and config from here as another user.
chmod 755 "$WORK"
ENV_FILE=docker/postgres/offsite.env

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    echo "--- SeaweedFS's log:" >&2; docker logs --tail 40 "$S3" >&2 2>&1 || true
    echo "--- pgBackRest's log:" >&2; docker compose exec -T postgres sh -c 'tail -n 30 /var/log/pgbackrest/*.log' >&2 || true
  fi
  docker rm -f "$S3" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$ENV_FILE"
}
trap cleanup EXIT

live() { docker compose exec -T postgres psql -X -At -U fms_admin -d fms_db -v ON_ERROR_STOP=1 -c "$1"; }
repo_max() { docker compose exec -T -u postgres postgres pgbackrest --stanza=fms --repo="$1" --output=json info 2>/dev/null | grep -o '"max":"[0-9A-F]*"' | cut -d'"' -f4 | sort | tail -1; }
# A segment with something in it, closed now: archive_timeout would close it within 60 s anyway.
new_segment() { live "select pg_walfile_name(pg_switch_wal()) from (select pg_logical_emit_message(false, 'fms-ci', 'offsite')) m"; }
# $1 >= $2 for WAL segment names (fixed-width hex, so they order as text).
ge() { [ -n "$1" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort | tail -1)" = "$1" ]; }
wait_for() { # seconds, description, command...
  limit=$1; what=$2; shift 2; i=0
  until "$@"; do
    i=$((i + 2)); [ "$i" -gt "$limit" ] && { echo "Not within $limit s: $what" >&2; return 1; }
    sleep 2
  done
}

echo "== An S3 bucket off site (SeaweedFS, TLS with a throwaway certificate)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$S3" -addext "subjectAltName=DNS:$S3" \
  -keyout "$WORK/private.key" -out "$WORK/public.crt" 2>/dev/null
chmod 644 "$WORK/private.key" "$WORK/public.crt"
KEY="ci$(openssl rand -hex 6)"
SECRET=$(openssl rand -hex 20)
printf '{"identities":[{"name":"fms","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read","List","Tagging","Write","Admin"]}]}' "$KEY" "$SECRET" > "$WORK/s3.json"
docker run -d --name "$S3" --network "$NETWORK" -v "$WORK:/conf:ro" "$IMAGE" \
  server -dir=/data -s3 -s3.port=9000 -s3.config=/conf/s3.json -s3.cert.file=/conf/public.crt -s3.key.file=/conf/private.key >/dev/null
wait_for 60 "SeaweedFS's S3 API" sh -c "docker logs $S3 2>&1 | grep -q 'S3 API Server'"
sleep 5
bucket() { echo "s3.bucket.create -name fms-offsite" | docker exec -i "$S3" weed shell 2>&1 | grep -q "created bucket"; }
wait_for 90 "the bucket to be created" bucket

echo "== repo2 configured: the database recreated with it"
umask 077
cat > "$ENV_FILE" <<EOF
PGBACKREST_REPO2_TYPE=s3
PGBACKREST_REPO2_PATH=/fms
PGBACKREST_REPO2_S3_BUCKET=fms-offsite
PGBACKREST_REPO2_S3_ENDPOINT=$S3
PGBACKREST_REPO2_STORAGE_PORT=9000
PGBACKREST_REPO2_S3_REGION=us-east-1
PGBACKREST_REPO2_S3_KEY=$KEY
PGBACKREST_REPO2_S3_KEY_SECRET=$SECRET
PGBACKREST_REPO2_S3_URI_STYLE=path
PGBACKREST_REPO2_STORAGE_VERIFY_TLS=n
PGBACKREST_REPO2_CIPHER_TYPE=aes-256-cbc
PGBACKREST_REPO2_CIPHER_PASS=$(openssl rand -hex 32)
EOF
umask 022
docker compose up -d --no-build postgres
wait_for 120 "the recreated database to accept connections" sh -c 'docker compose exec -T postgres pg_isready -q -h 127.0.0.1 -U fms_admin -d fms_db'
wait_for 300 "repo2's first full backup" sh -c "docker compose exec -T -u postgres postgres pgbackrest --stanza=fms --repo=2 --output=json info 2>/dev/null | grep -q '\"type\":\"full\"'"

echo "== A new segment reaches both repositories within 60 s"
SEG=$(new_segment)
in_both() { ge "$(repo_max 1)" "$SEG" && ge "$(repo_max 2)" "$SEG"; }
wait_for 60 "segment $SEG in repo1 and repo2" in_both

echo "== The network to repo2 cut: archiving fails, repo1 keeps every segment"
docker network disconnect "$NETWORK" "$S3"
FAILED_BEFORE=$(live "select failed_count from pg_stat_archiver")
CUT=$(new_segment)
failing() { [ "$(live "select failed_count from pg_stat_archiver")" -gt "$FAILED_BEFORE" ]; }
wait_for 120 "archive failures while repo2 is unreachable" failing
in_repo1() { ge "$(repo_max 1)" "$CUT"; }
wait_for 60 "segment $CUT in repo1 while repo2 is unreachable" in_repo1
[ "$(live "select coalesce(last_archived_wal < '$CUT', true)::text from pg_stat_archiver")" = true ] \
  || { echo "Archiving reported $CUT done while repo2 was unreachable" >&2; exit 1; }

echo "== The network back: archiving catches up, repo2 holds every segment again"
docker network connect "$NETWORK" "$S3"
AFTER=$(new_segment)
caught_up() { [ "$(live "select coalesce(last_archived_wal >= '$AFTER', false)::text from pg_stat_archiver")" = true ]; }
wait_for 180 "archiving to catch up after the network came back" caught_up
in_repo2() { ge "$(repo_max 2)" "$AFTER"; }
wait_for 60 "segment $AFTER in repo2" in_repo2

echo "== repo2 removed again: the database recreated without it"
rm -f "$ENV_FILE"
docker compose up -d --no-build postgres
wait_for 120 "the database to accept connections" sh -c 'docker compose exec -T postgres pg_isready -q -h 127.0.0.1 -U fms_admin -d fms_db'
echo "Off-site repository passed: both repositories within 60 s, failures while cut off, caught up after."
