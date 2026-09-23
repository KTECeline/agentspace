#!/usr/bin/env bash
# Phase 1 "done" check:
#   1. docker compose up: collector + web are healthy
#   2. the example's agents show up in the collector live
#   3. killing the collector mid-run does NOT crash the example (exit code 0)
set -euo pipefail
cd "$(dirname "$0")/.."

COLLECTOR=${AGENTSPACE_URL:-http://localhost:4800}
LOG=$(mktemp)
trap 'rm -f "$LOG"; docker compose start collector >/dev/null 2>&1 || true' EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Starting collector + web (docker compose up)"
docker compose up -d --build --wait

step "Running the example (fake model, 4 runs) in the background"
(cd examples/langgraph-dev-team && VIRTUAL_ENV= uv run python main.py --fake --runs 4 --latency 0.5) >"$LOG" 2>&1 &
EXAMPLE_PID=$!

step "Waiting for agents to appear live in the collector"
for _ in $(seq 1 40); do
  n=$(curl -fsS "$COLLECTOR/v1/workspaces/default/agents" 2>/dev/null | python3 -c 'import json,sys; print(sum(1 for a in json.load(sys.stdin) if a["agent_id"] in ("manager","triage","engineer")))' 2>/dev/null || echo 0)
  [ "$n" = 3 ] && break
  sleep 0.5
done
[ "$n" = 3 ] || { echo "FAIL: agents did not appear"; cat "$LOG"; exit 1; }
echo "ok: manager, triage, engineer are live"

step "Killing the collector mid-run"
docker compose kill collector >/dev/null
echo "collector killed"

step "Waiting for the example to finish"
if wait "$EXAMPLE_PID"; then
  echo "ok: example exited 0 with the collector down"
else
  echo "FAIL: example exited non-zero"; cat "$LOG"; exit 1
fi
grep -q "run 4:" "$LOG" || { echo "FAIL: example did not complete all runs"; cat "$LOG"; exit 1; }
cat "$LOG"

step "Restarting the collector"
docker compose start collector >/dev/null
docker compose up -d --wait >/dev/null
echo "ok: collector is back. Office: http://localhost:${AGENTSPACE_WEB_PORT:-4801}"
printf '\n\033[1;32mPASS\033[0m Phase 1 done-check\n'
