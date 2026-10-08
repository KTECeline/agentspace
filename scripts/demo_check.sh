#!/usr/bin/env bash
# Done-check (Phases 1-4b):
#   1. docker compose up: collector + web are healthy
#   2. the web image serves the office, /demo (and its bundled recording), /demo/compare, /dashboard, /replay and /compare
#   3. approvals and pause / resume / cancel work end to end (scripts/controls_check.sh)
#   3b. costs, the price table and the stats API (scripts/cost_check.sh)
#   4. the example's agents show up in the collector live
#   5. killing the collector mid-run does NOT crash the example (exit code 0)
set -euo pipefail
cd "$(dirname "$0")/.."

COLLECTOR=${AGENTSPACE_URL:-http://localhost:4800}
WEB=http://localhost:${AGENTSPACE_WEB_PORT:-4801}
# A fresh workspace per check, so agents left over from earlier runs can't make it pass.
WS="check-$(date +%s)"
LOG=$(mktemp)
trap 'rm -f "$LOG"; docker compose start collector >/dev/null 2>&1 || true' EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Starting collector + web (docker compose up)"
if [ "${SKIP_BUILD:-}" = 1 ]; then
  docker compose up -d --wait  # use existing images (e.g. no registry access)
else
  docker compose up -d --build --force-recreate --wait
fi

step "Checking the web app (office, /demo, /demo/compare, bundled recording, /dashboard, /replay, /compare)"
for path in / /demo /demo/compare /dashboard "/replay?run=none" /compare; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$WEB$path")
  [ "$code" = 200 ] || { echo "FAIL: GET $path -> $code"; exit 1; }
done
curl -fsS "$WEB/recordings/dev-team.json" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["format"]=="agentspace-recording" and len(r["events"])>10' \
  || { echo "FAIL: recording missing or invalid"; exit 1; }
echo "ok: /, /demo, /demo/compare, the recording, /dashboard, /replay and /compare are served"

step "Approvals and run controls"
AGENTSPACE_URL="$COLLECTOR" scripts/controls_check.sh

step "Costs, price table and stats"
AGENTSPACE_URL="$COLLECTOR" scripts/cost_check.sh

step "Running the example (fake model, 4 runs) in the background"
(cd examples/langgraph-dev-team && AGENTSPACE_WORKSPACE="$WS" VIRTUAL_ENV= uv run python main.py --fake --runs 4 --latency 0.5) >"$LOG" 2>&1 &
EXAMPLE_PID=$!

step "Waiting for agents to appear live in the collector"
for _ in $(seq 1 60); do
  n=$(curl -fsS "$COLLECTOR/v1/workspaces/$WS/agents" 2>/dev/null | python3 -c 'import json,sys; print(sum(1 for a in json.load(sys.stdin) if a["agent_id"] in ("manager","triage","engineer")))' 2>/dev/null || echo 0)
  [ "$n" = 3 ] && break
  sleep 0.5
done
[ "$n" = 3 ] || { echo "FAIL: agents did not appear"; cat "$LOG"; exit 1; }
echo "ok: manager, triage, engineer are live in workspace $WS ($WEB/?workspace=$WS)"

step "Checking an OpenTelemetry-only agent (no AgentSpace SDK) shows up via OTLP"
(cd examples/otel-generic && AGENTSPACE_WORKSPACE="$WS-otel" VIRTUAL_ENV= uv run python main.py --latency 0.1) >/dev/null 2>&1
for _ in $(seq 1 40); do
  m=$(curl -fsS "$COLLECTOR/v1/workspaces/$WS-otel/agents" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
  [ "$m" -ge 3 ] && break
  sleep 0.5
done
[ "$m" -ge 3 ] || { echo "FAIL: OTLP agents did not appear"; exit 1; }
echo "ok: router, researcher, writer arrived over OTLP"

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
grep -Eq "sent=[1-9]" "$LOG" || { echo "FAIL: no events reached the collector before it was killed"; cat "$LOG"; exit 1; }
cat "$LOG"

step "Restarting the collector"
docker compose start collector >/dev/null
docker compose up -d --wait >/dev/null
echo "ok: collector is back. Office: http://localhost:${AGENTSPACE_WEB_PORT:-4801}"
printf '\n\033[1;32mPASS\033[0m done-check\n'
