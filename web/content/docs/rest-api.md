# Collector API

All endpoints are JSON over HTTP on the collector (port 4800). When auth is configured, send `Authorization: Bearer <token>`. See [Security and auth](security) for which token each endpoint needs.

## Ingest

| Method and path | What it does |
|---|---|
| `POST /v1/events` | `{"events": [...]}`, at most 1,000. Each is validated on its own. The reply has `accepted`, `duplicates`, `rejected`, the first few `errors`, and `controls` for runs an operator paused or cancelled. |
| `POST /v1/traces` | OTLP/HTTP traces, JSON or protobuf, optionally gzipped ([OpenTelemetry](opentelemetry)). |

## Reading

| Method and path | What it returns |
|---|---|
| `GET /v1/info` | whether auth is needed, whether operator actions are possible, and whether public mode is on |
| `GET /v1/pricing` | the price table (no token needed) |
| `GET /v1/workspaces` | workspaces and their agent counts |
| `GET /v1/workspaces/:ws/agents` | agent state |
| `GET /v1/workspaces/:ws/runs?limit=` | recent runs, with totals |
| `GET /v1/workspaces/:ws/runs/:run` | one run |
| `GET /v1/workspaces/:ws/runs/:run/events?after=&limit=` | a run's events in order (page with `after`, the last `seq`) |
| `GET /v1/workspaces/:ws/events?limit=` | recent events |
| `GET /v1/workspaces/:ws/stats?since=&until=` | aggregates for the Costs page ([below](#stats)) |
| `GET /v1/ws?workspace=` | WebSocket: a `snapshot`, then `events`, `agents`, `runs` and `approvals` deltas. Send `{"type": "auth", "token": "…"}` first when auth is on. |
| `GET /healthz` | liveness |

## Approvals and controls

| Method and path | What it does |
|---|---|
| `GET /v1/workspaces/:ws/approvals?status=` | approvals (`pending`, `approved`, `rejected`, `timeout`) |
| `GET /v1/workspaces/:ws/approvals/:id?wait=` | one approval; `wait` (seconds, at most 30) long-polls until it's decided |
| `POST /v1/workspaces/:ws/approvals/:id/resolve` | `{"decision": "approved" \| "rejected", "comment", "by"}`: `409` if already decided |
| `POST /v1/workspaces/:ws/runs/:run/control` | `{"action": "pause" \| "resume" \| "cancel", "by"}` |
| `GET /v1/workspaces/:ws/controls?runs=a,b&wait=` | the control state of those runs (the SDKs long-poll this while paused) |
| `GET /v1/workspaces/:ws/policy?runs=a,b` | `{"policy", "escalated"}`: the collector's [policy](policy) (or `null`) and which of those runs have findings. Ingest responses list `escalated` runs too. |

An approval asked by a policy carries `policy` (the rule that asked) and, once the collector has worked it out, `context` (the run's findings, tool calls and cost against the workflow's usual runs).

## Stats

`GET /v1/workspaces/:ws/stats?since=2026-09-01T00:00:00Z` returns, for events with `since <= ts < until` (both optional):

- `totals`: calls, tokens, `cost_usd`, `cost_estimated_usd`, `unpriced_calls`, p50/p95 model latency, runs by status, `error_rate`, errors, tool calls and tool errors;
- `by_run` (most recent 200), `by_agent`, `by_model` and `by_day`, each with the same cost totals;
- `slowest_tools`: the ten slowest by p95, with calls and errors.

It's aggregates only, so it's the same in public read-only mode.
