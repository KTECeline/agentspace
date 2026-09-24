#!/usr/bin/env bash
# Verify a public demo deployment is read-only replay and leaks nothing.
#   scripts/check_public_demo.sh https://agentspace-demo.vercel.app
# Checks: collector pages redirect to /demo (even with ?collector=), /demo, /docs and the
# recordings are served, the CSP only allows same-origin connections, there are no API or
# write routes, and the page and its scripts contain no keys, tokens or personal data.
set -euo pipefail
BASE=${1:?usage: $0 <deployment url>}
BASE=${BASE%/}
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
H=(-sS -A agentspace-demo-check ${VERCEL_BYPASS:+-H "x-vercel-protection-bypass: $VERCEL_BYPASS"})

for path in "/" "/dashboard" "/replay?run=x&collector=https://attacker.example" "/?collector=https://attacker.example"; do
  loc=$(curl "${H[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE$path")
  [[ "$loc" =~ ^30[1278]\ .*/demo ]] || fail "$path should redirect to /demo, got: $loc"
done
ok "the live office, /dashboard and /replay redirect to /demo, even with ?collector="

for path in /demo /docs /docs/security /recordings/dev-team.json; do
  code=$(curl "${H[@]}" -o /dev/null -w '%{http_code}' "$BASE$path")
  [ "$code" = 200 ] || fail "GET $path -> $code"
done
ok "/demo, /docs and the recordings are served"

csp=$(curl "${H[@]}" -D - -o /dev/null "$BASE/demo" | tr -d '\r' | grep -i '^content-security-policy:' || true)
[[ "$csp" == *"connect-src 'self'"* ]] || fail "missing CSP connect-src 'self' (got: ${csp:-none})"
[[ "$csp" == *"frame-ancestors 'none'"* ]] || fail "missing CSP frame-ancestors 'none'"
ok "CSP: the browser can only connect to this origin (no collector reachable)"

for req in "POST /v1/events" "GET /v1/info" "POST /v1/workspaces/default/approvals/x/resolve" "POST /v1/workspaces/default/runs/x/control" "GET /v1/ws" "GET /api/health"; do
  code=$(curl "${H[@]}" -o /dev/null -w '%{http_code}' -X "${req%% *}" -H 'content-type: application/json' -d '{}' "$BASE${req#* }")
  [[ "$code" =~ ^(404|405|30[1278])$ ]] || fail "$req -> $code (expected no such route)"
done
ok "no ingest, approval, control, WebSocket or API routes exist"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl "${H[@]}" "$BASE/demo" >"$tmp/page.html"
grep -oE '/_next/static/[^"'"'"' ]+\.js' "$tmp/page.html" | sort -u | while read -r js; do curl "${H[@]}" "$BASE$js"; done >"$tmp/bundle.js"
for f in /recordings/dev-team.json /recordings/claude-support-desk.json /recordings/crewai-research-desk.json /recordings/openai-support-desk.json /recordings/otel-support-bot.json; do curl "${H[@]}" "$BASE$f"; done >"$tmp/recordings.json"
[ -s "$tmp/bundle.js" ] || fail "couldn't fetch the page's scripts"
if grep -aEo 'sk-(or|ant|proj)-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY' "$tmp"/*; then fail "a key-like string is served"; fi
# Home paths and email addresses; add your own names with EXTRA_PATTERNS='alice|bob' (kept out of git).
PERSONAL='/Users/[a-z]|/home/[a-z]|[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|proton)\.[a-z]+'
if grep -aEio "$PERSONAL${EXTRA_PATTERNS:+|$EXTRA_PATTERNS}" "$tmp"/*; then fail "personal data is served"; fi
ok "the page, its $(du -h "$tmp/bundle.js" | cut -f1 | tr -d ' ') of scripts and the recordings contain no keys, tokens or personal data"

printf '\n\033[1;32mPASS\033[0m public demo at %s is read-only replay\n' "$BASE"
