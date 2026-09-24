#!/usr/bin/env bash
# Done-check (Phase 4b): costs, the price table and the stats API, against a running collector.
#   1. an llm.call with tokens and no cost is priced from the table ("estimated", with as_of)
#   2. a reported cost, and a call whose cost is reported elsewhere, are never re-priced
#   3. an unknown model stays unpriced and is counted as such
#   4. run totals keep reported and estimated apart; the stats API agrees
#   5. every model in GET /v1/pricing has an as_of date and an official source URL
#   6. the stats API carries aggregates only (no approval payloads)
# Needs a collector at AGENTSPACE_URL (default http://localhost:4800) without auth, or pass an
# operator token in AGENTSPACE_OPERATOR_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

COLLECTOR=${AGENTSPACE_URL:-http://localhost:4800}
WS="cost-$(date +%s)"
RUN="cost-run-1"
AUTH=()
[ -n "${AGENTSPACE_OPERATOR_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTSPACE_OPERATOR_TOKEN")

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
api() { curl -fsS "${AUTH[@]}" "$@"; }
check() { # check <description> <python expression over d>
  python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($2) else 1)" || { echo "FAIL: $1"; exit 1; }
  echo "ok: $1"
}

step "Ingest model calls with every kind of cost"
python3 - "$WS" "$RUN" <<'EOF' | api -X POST -H 'content-type: application/json' --data-binary @- "$COLLECTOR/v1/events" >/dev/null
import json, sys
ws, run = sys.argv[1], sys.argv[2]
def ev(i, type, extra, data):
    return {"spec_version": "0.1", "id": f"{ws}-{i}", "type": type, "ts": "2026-09-24T12:00:0%dZ" % i,
            "workspace": ws, "run_id": run, "agent_id": "a" if type != "run.started" else None,
            "team_id": None, "parent_id": None, "data": data, **extra}
events = [
    ev(0, "run.started", {}, {"name": "cost-check"}),
    # 1M input tokens of Claude Haiku 4.5 at $1/MTok: estimated $1
    ev(1, "llm.call", {"model": "claude-haiku-4-5-20251001", "tokens_in": 1_000_000, "tokens_out": 0}, {"duration_ms": 900}),
    # reported by the framework: kept as is
    ev(2, "llm.call", {"model": "claude-haiku-4-5", "tokens_in": 10, "cost_usd": 0.25}, {"duration_ms": 100}),
    # billed on another event (the Claude Agent SDK's per-message calls): never priced
    ev(3, "llm.call", {"model": "claude-haiku-4-5", "tokens_in": 1_000_000, "cost_source": "reported"}, {}),
    # not in the price table
    ev(4, "llm.call", {"model": "my-local-model", "tokens_in": 500}, {}),
    ev(5, "approval.requested", {}, {"approval_id": f"{ws}-ap", "reason": "ok?", "payload": {"secret": "PAYLOAD-MUST-NOT-LEAK"}}),
    ev(6, "run.finished", {}, {"status": "ok"}),
]
events[5]["agent_id"] = "a"
events[6]["agent_id"] = None
print(json.dumps({"events": events}))
EOF

EVENTS=$(api "$COLLECTOR/v1/workspaces/$WS/runs/$RUN/events")
echo "$EVENTS" | check "an unpriced call with tokens is estimated from the table" \
  'any(e["id"].endswith("-1") and e.get("cost_source")=="estimated" and abs(e["cost_usd"]-1)<1e-9 and e["attributes"]["agentspace.price_as_of"] for e in d)'
echo "$EVENTS" | check "a reported cost is kept, never re-priced" \
  'any(e["id"].endswith("-2") and e["cost_usd"]==0.25 and "cost_source" not in e for e in d)'
echo "$EVENTS" | check "a call billed elsewhere gets no estimate" \
  'any(e["id"].endswith("-3") and "cost_usd" not in e for e in d)'
echo "$EVENTS" | check "an unknown model stays unpriced" \
  'any(e["id"].endswith("-4") and "cost_usd" not in e and "cost_source" not in e for e in d)'

step "Totals and stats"
api "$COLLECTOR/v1/workspaces/$WS/runs/$RUN" | check "run totals: \$1.25 = \$1 estimated + \$0.25 reported, 1 unpriced call" \
  'abs(d["cost_usd"]-1.25)<1e-9 and abs(d["cost_estimated_usd"]-1)<1e-9 and d["unpriced_calls"]==1'
STATS=$(api "$COLLECTOR/v1/workspaces/$WS/stats")
echo "$STATS" | check "stats agree with the run totals" \
  'abs(d["totals"]["cost_usd"]-1.25)<1e-9 and abs(d["totals"]["cost_estimated_usd"]-1)<1e-9 and d["totals"]["unpriced_calls"]==1 and d["totals"]["runs_ok"]==1'
echo "$STATS" | check "stats group cost by model" \
  '[m["model"] for m in d["by_model"]][0]=="claude-haiku-4-5-20251001"'
echo "$STATS" | check "stats carry no approval payloads" '"PAYLOAD-MUST-NOT-LEAK" not in json.dumps(d)'

step "Price table"
curl -fsS "$COLLECTOR/v1/pricing" | check "every model has an as_of date and an https source" \
  'len(d["models"])>0 and all(len(m["as_of"])==10 and m["source"].startswith("https://") for m in d["models"])'

printf '\n\033[1;32mPASS\033[0m cost check\n'
