#!/bin/sh
# Game day (FMS-162, docs/disaster-recovery.md#game-day): a failover rehearsed under load, on a stack with data
# (staging, or the development stack after the seed).
#
#   sh scripts/dr/gameday.sh [--points 1000] [--after 300] [--failback]
#
#   1. A GPS device sends --points positions through the API, one a request, retrying each 503 until it is stored
#      (packages/backend/scripts/dr-gameday.ts, in the backend container).
#   2. After --after of them, promote.sh fails the database over: the primary is fenced and the standby promoted.
#   3. When the sender is done: every position must be stored, once. Prints the times to record in the DR plan.
#   4. rejoin.sh makes the old primary the standby; --failback then fails over again, so the stack ends as it began.
# Exits 1 when a position was lost, or a step failed.
set -eu

POINTS=1000
AFTER=300
FAILBACK=0
API=fms_backend
while [ $# -gt 0 ]; do
  case "$1" in
    --points) POINTS="$2"; shift 2 ;;
    --after) AFTER="$2"; shift 2 ;;
    --failback) FAILBACK=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
START=$(date +%s)
echo "== Game day: $POINTS positions through the API, a failover after $AFTER"
docker exec "$API" npx tsx scripts/dr-gameday.ts --points "$POINTS" > "$LOG" 2>&1 &
SENDER=$!

i=0
until grep -q "^sent $AFTER$" "$LOG"; do
  kill -0 "$SENDER" 2>/dev/null || { echo "The sender stopped before $AFTER positions:" >&2; cat "$LOG" >&2; exit 1; }
  i=$((i + 1)); [ "$i" -gt 600 ] && { echo "The sender did not reach $AFTER positions in 5 minutes" >&2; exit 1; }
  sleep 0.5
done

echo "== Failing over"
FAILOVER_START=$(date +%s)
sh scripts/dr/promote.sh --yes
FAILOVER_SECONDS=$(( $(date +%s) - FAILOVER_START ))

echo "== Waiting for the sender"
STATUS=0
wait "$SENDER" || STATUS=$?
grep -v '^sent ' "$LOG" || true
SUMMARY=$(grep '^{' "$LOG" | tail -1)

echo "== Rejoining the old primary as the standby"
REJOIN_START=$(date +%s)
sh scripts/dr/rejoin.sh
REJOIN_SECONDS=$(( $(date +%s) - REJOIN_START ))

if [ "$FAILBACK" = 1 ]; then
  echo "== Failing back"
  sh scripts/dr/promote.sh --yes
  sh scripts/dr/rejoin.sh
fi

echo
echo "Game day $(date -u +%Y-%m-%d), for docs/disaster-recovery.md:"
echo "  failover (fence, promote, endpoint, API ok): ${FAILOVER_SECONDS} s"
echo "  old primary back as the standby:             ${REJOIN_SECONDS} s"
echo "  positions:                                   ${SUMMARY:-none}"
echo "  whole run:                                   $(( $(date +%s) - START )) s"
[ "$STATUS" = 0 ] || { echo "Positions were lost, or the sender failed." >&2; exit 1; }
