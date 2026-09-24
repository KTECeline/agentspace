#!/usr/bin/env bash
# Done-check (Phase 4a): approvals and run controls, end to end against a running collector.
#   1. the example's Engineer asks for approval; approving over REST lets the run finish
#   2. resolving it again is a 409 (idempotent, no duplicate event)
#   3. pause blocks the next run's agents; resume lets them go on
#   4. cancel stops the example cleanly ("cancelled", exit code 0)
# Needs a collector at AGENTSPACE_URL (default http://localhost:4800) without auth, or pass an
# operator token in AGENTSPACE_OPERATOR_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

COLLECTOR=${AGENTSPACE_URL:-http://localhost:4800}
WS="controls-$(date +%s)"
LOG=$(mktemp)
AUTH=()
[ -n "${AGENTSPACE_OPERATOR_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTSPACE_OPERATOR_TOKEN")
EXAMPLE_PID=""
trap 'rm -f "$LOG"; [ -n "$EXAMPLE_PID" ] && kill "$EXAMPLE_PID" 2>/dev/null || true' EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
api() { curl -fsS "${AUTH[@]}" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
example() {
  (cd examples/langgraph-dev-team && AGENTSPACE_URL="$COLLECTOR" AGENTSPACE_API_KEY="${AGENTSPACE_OPERATOR_TOKEN:-}" \
    AGENTSPACE_WORKSPACE="$WS" VIRTUAL_ENV= uv run python main.py --fake "$@") >"$LOG" 2>&1 &
  EXAMPLE_PID=$!
}
wait_for() { # wait_for <description> <command...>: retry for up to 30 s
  local what=$1; shift
  for _ in $(seq 1 60); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "FAIL: $what"; cat "$LOG"; exit 1
}

step "Approval: the Engineer asks before writing a file"
example --approve --latency 0.2
pending() { api "$COLLECTOR/v1/workspaces/$WS/approvals?status=pending" | json 'd[0]["approval_id"]'; }
wait_for "no approval was requested" pending
ID=$(pending)
api -X POST -H 'content-type: application/json' -d '{"decision":"approved","comment":"lgtm","by":"done-check"}' \
  "$COLLECTOR/v1/workspaces/$WS/approvals/$ID/resolve" >/dev/null
wait "$EXAMPLE_PID" || { echo "FAIL: example exited non-zero"; cat "$LOG"; exit 1; }
EXAMPLE_PID=""
grep -q "tests pass" "$LOG" || { echo "FAIL: the approved fix did not complete"; cat "$LOG"; exit 1; }
echo "ok: approved over REST; the run finished"

code=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d '{"decision":"rejected"}' "$COLLECTOR/v1/workspaces/$WS/approvals/$ID/resolve")
[ "$code" = 409 ] || { echo "FAIL: second resolve returned $code, expected 409"; exit 1; }
n=$(api "$COLLECTOR/v1/workspaces/$WS/events?limit=2000" | json 'sum(1 for e in d if e["type"]=="approval.resolved")')
[ "$n" = 1 ] || { echo "FAIL: $n approval.resolved events, expected 1"; exit 1; }
echo "ok: resolving twice is a 409 with no duplicate event"

step "Pause, resume and cancel a long-running example"
example --runs 0 --latency 0.4
running() { api "$COLLECTOR/v1/workspaces/$WS/runs" | json '[r["run_id"] for r in d if r["status"]=="running"][0]'; }
wait_for "no running run appeared" running
RUN=$(running)
control() { api -X POST -H 'content-type: application/json' -d "{\"action\":\"$1\",\"by\":\"done-check\"}" "$COLLECTOR/v1/workspaces/$WS/runs/$RUN/control" >/dev/null; }

control pause
blocked() { api "$COLLECTOR/v1/workspaces/$WS/agents" | json '[a for a in d if a["status"]=="blocked"][0]["agent_id"]'; }
wait_for "no agent showed as blocked after pause" blocked
echo "ok: paused; $(blocked) is blocked"
control resume
unblocked() { [ -z "$(api "$COLLECTOR/v1/workspaces/$WS/agents" | json '"".join(a["agent_id"] for a in d if a["status"]=="blocked")')" ]; }
wait_for "agents stayed blocked after resume" unblocked
echo "ok: resumed"

control cancel
wait_for "the example did not stop after cancel" bash -c "! kill -0 $EXAMPLE_PID"
wait "$EXAMPLE_PID" || { echo "FAIL: example exited non-zero after cancel"; cat "$LOG"; exit 1; }
EXAMPLE_PID=""
grep -q "cancelled from the office" "$LOG" || { echo "FAIL: example didn't report the cancel"; cat "$LOG"; exit 1; }
status=$(api "$COLLECTOR/v1/workspaces/$WS/runs/$RUN" | json 'd["status"]')
[ "$status" = cancelled ] || { echo "FAIL: run status is $status, expected cancelled"; exit 1; }
echo "ok: cancelled; the example stopped cleanly and the run is \"cancelled\""

printf '\n\033[1;32mPASS\033[0m controls check\n'
